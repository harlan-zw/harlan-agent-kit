#!/usr/bin/env -S node --experimental-strip-types
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export const managedTools = [
  {
    name: 'gh',
    repository: 'cli/cli',
    asset: (arch: string) => new RegExp(`^gh_[0-9.]+_linux_${arch === 'arm64' ? 'arm64' : 'amd64'}\\.tar\\.gz$`),
  },
  {
    name: 'codex',
    repository: 'openai/codex',
    asset: (arch: string) =>
      new RegExp(`^codex-package-${arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl\\.tar\\.gz$`),
  },
  { name: 'opencode' },
  {
    name: 'bun',
    repository: 'oven-sh/bun',
    asset: (arch: string) => new RegExp(`^bun-linux-${arch === 'arm64' ? 'aarch64' : 'x64-baseline'}\\.zip$`),
  },
  {
    name: 'wt',
    repository: 'max-sixty/worktrunk',
    asset: (arch: string) =>
      new RegExp(`^worktrunk-${arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl\\.tar\\.xz$`),
  },
  {
    name: 'rg',
    repository: 'BurntSushi/ripgrep',
    asset: (arch: string) =>
      new RegExp(`^ripgrep-[0-9.]+-${arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl\\.tar\\.gz$`),
  },
  {
    name: 'fd',
    repository: 'sharkdp/fd',
    asset: (arch: string) =>
      new RegExp(`^fd-v[0-9.]+-${arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl\\.tar\\.gz$`),
  },
] as const

interface ReleaseAsset {
  name: string
  digest: string
  browser_download_url: string
}

/** V2 publishes native archives through npm, independently of the V1 GitHub releases. */
export function opencodeToolRelease(value: unknown, arch: string): { tag: string; asset: ReleaseAsset } {
  if (arch !== 'x64' && arch !== 'arm64') throw new Error(`The Agent tool architecture is unsupported: ${arch}`)
  if (typeof value !== 'object' || value === null) throw new Error('The OpenCode release must contain an object.')
  const release = value as { name?: unknown; version?: unknown; dist?: { integrity?: unknown; tarball?: unknown } }
  const name = `@opencode/cli-linux-${arch === 'arm64' ? 'arm64' : 'x64-baseline'}`
  if (
    release.name !== name ||
    typeof release.version !== 'string' ||
    !/^2\.\d+\.\d+$/.test(release.version) ||
    typeof release.dist?.integrity !== 'string' ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(release.dist.integrity)
  ) {
    throw new Error('The OpenCode release must be a verified V2 native package.')
  }
  const archive = `${name.slice('@opencode/'.length)}-${release.version}.tgz`
  if (release.dist.tarball !== `https://registry.npmjs.org/${name}/-/${archive}`)
    throw new Error('The OpenCode release archive must use the official registry.')
  return {
    tag: `v${release.version}`,
    asset: {
      name: archive,
      digest: `sha512:${Buffer.from(release.dist.integrity.slice(7), 'base64').toString('hex')}`,
      browser_download_url: release.dist.tarball,
    },
  }
}

/** Parse stable release metadata before using its archive or download URL. */
export function agentToolRelease(
  value: unknown,
  tool: (typeof managedTools)[number],
  arch: string,
): { tag: string; asset: ReleaseAsset } {
  if (tool.name === 'opencode') return opencodeToolRelease(value, arch)
  if (arch !== 'x64' && arch !== 'arm64') throw new Error(`The Agent tool architecture is unsupported: ${arch}`)
  if (typeof value !== 'object' || value === null) throw new Error('The Agent tool release must contain an object.')
  const release = value as Record<string, unknown>
  if (
    typeof release.tag_name !== 'string' ||
    !/^[\w.-]+$/.test(release.tag_name) ||
    release.prerelease !== false ||
    release.draft !== false ||
    !Array.isArray(release.assets)
  ) {
    throw new Error('The Agent tool release must be stable and published.')
  }
  const matches = release.assets.filter((value): value is ReleaseAsset => {
    if (typeof value !== 'object' || value === null) return false
    const asset = value as Record<string, unknown>
    return typeof asset.name === 'string' && tool.asset(arch).test(asset.name)
  })
  const asset = matches[0]
  if (
    matches.length !== 1 ||
    asset === undefined ||
    typeof asset.digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
    asset.browser_download_url !==
      `https://github.com/${tool.repository}/releases/download/${release.tag_name}/${asset.name}`
  ) {
    throw new Error(`The Agent tool needs one verified release archive: ${tool.name}`)
  }
  return { tag: release.tag_name, asset }
}

/** Install only the checked archive member. Existing installations stay untouched on failure. */
export async function syncAgentTool(input: {
  home: string
  tool: (typeof managedTools)[number]
  release: unknown
  arch: string
  download: (url: string) => Promise<Buffer>
}): Promise<'Updated' | 'Current'> {
  const release = agentToolRelease(input.release, input.tool, input.arch)
  const root = join(input.home, '.local/share/wolfstar-agent-kit/tools')
  const binary = join(root, 'bin', input.tool.name)
  const receipt = join(root, `${input.tool.name}.json`)
  const executableNames = input.tool.name === 'codex' ? ['codex', 'codex-code-mode-host'] : [input.tool.name]
  const previous = await readFile(receipt, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (previous !== undefined) {
    const record = JSON.parse(previous) as { digest?: string }
    if (
      record.digest === release.asset.digest &&
      (
        await Promise.all(
          executableNames.map((name) =>
            stat(join(root, 'bin', name))
              .then((metadata) => metadata.isFile() && (metadata.mode & 0o111) !== 0)
              .catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT') return false
                throw error
              }),
          ),
        )
      ).every(Boolean)
    ) {
      return 'Current'
    }
  }
  const bytes = await input.download(release.asset.browser_download_url)
  const algorithm = input.tool.name === 'opencode' ? 'sha512' : 'sha256'
  if (`${algorithm}:${createHash(algorithm).update(bytes).digest('hex')}` !== release.asset.digest)
    throw new Error(`The Agent tool archive checksum differs: ${input.tool.name}`)
  const scratch = await mkdtemp(join(tmpdir(), 'agent-tool-'))
  await mkdir(join(root, 'bin'), { recursive: true, mode: 0o700 })
  const staged = `${binary}.${randomUUID()}`
  const bundle = `${staged}.bundle`
  const previousBundle =
    input.tool.name === 'codex'
      ? await realpath(binary)
          .then(dirname)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined
            throw error
          })
      : undefined
  let currentBundle: string | undefined
  try {
    const archive = join(scratch, release.asset.name)
    await writeFile(archive, bytes, { mode: 0o600 })
    const zip = release.asset.name.endsWith('.zip')
    const members = (
      await execute(zip ? '/usr/bin/unzip' : '/usr/bin/tar', zip ? ['-Z1', archive] : ['-tf', archive], {
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout
      .trim()
      .split('\n')
    await mkdir(bundle, { mode: 0o700 })
    for (const name of executableNames) {
      const candidates = members.filter((member) => member === name || member.endsWith(`/${name}`))
      const member = candidates[0]
      if (candidates.length !== 1 || member === undefined || member.startsWith('/') || member.split('/').includes('..'))
        throw new Error(`The Agent tool archive has no unique executable: ${name}`)
      const contents = (
        await execute(
          zip ? '/usr/bin/unzip' : '/usr/bin/tar',
          zip ? ['-p', archive, member] : ['-xOf', archive, member],
          { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
        )
      ).stdout
      if (contents.subarray(0, 4).toString('hex') !== '7f454c46')
        throw new Error(`The Agent tool archive must contain a native executable: ${name}`)
      await writeFile(join(bundle, name), contents, { mode: 0o755 })
    }
    await execute(join(bundle, input.tool.name), ['--version'], { timeout: 30_000 })
    if (input.tool.name === 'codex') {
      // Resolve Codex and its sibling from one immutable directory, even during sync.
      const installed = await mkdtemp(join(root, 'codex-release-'))
      await rename(bundle, installed)
      currentBundle = installed
      const hostLink = `${staged}.host`
      await symlink(join(installed, 'codex-code-mode-host'), hostLink)
      await rename(hostLink, join(root, 'bin/codex-code-mode-host'))
      await symlink(join(installed, 'codex'), staged)
    } else {
      await rename(join(bundle, input.tool.name), staged)
      await chmod(staged, 0o755)
    }
    await rename(staged, binary)
    const stagedReceipt = join(scratch, 'receipt.json')
    await writeFile(stagedReceipt, JSON.stringify({ tag: release.tag, digest: release.asset.digest }), { mode: 0o600 })
    // The receipt lives on the same filesystem as the installed executable.
    await writeFile(`${staged}.json`, await readFile(stagedReceipt), { mode: 0o600 })
    await rename(`${staged}.json`, receipt)
    if (currentBundle !== undefined) {
      // Running namespaces pin both executables. Keep the previous version for startup races.
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name)
        if (
          entry.isDirectory() &&
          entry.name.startsWith('codex-release-') &&
          path !== currentBundle &&
          path !== previousBundle
        )
          await rm(path, { recursive: true, force: true })
      }
    }
    return 'Updated'
  } finally {
    await rm(staged, { force: true })
    await rm(`${staged}.json`, { force: true })
    await rm(`${staged}.host`, { force: true })
    await rm(bundle, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
  }
}

async function main() {
  if (process.platform !== 'linux') throw new Error('Agent tool sync requires Linux.')
  const home = resolve(process.env.HOME!)
  for (const tool of managedTools) {
    const metadata: unknown =
      tool.name === 'opencode'
        ? await fetch(
            `https://registry.npmjs.org/@opencode%2fcli-linux-${process.arch === 'arm64' ? 'arm64' : 'x64-baseline'}/latest`,
            { signal: AbortSignal.timeout(30_000) },
          ).then((response) => {
            if (!response.ok) throw new Error(`The OpenCode release read failed: ${response.status}`)
            return response.json()
          })
        : JSON.parse(
            (
              await execute(join(home, '.local/bin/agent-gh'), ['api', `repos/${tool.repository}/releases/latest`], {
                timeout: 30_000,
              })
            ).stdout,
          )
    const result = await syncAgentTool({
      home,
      tool,
      release: metadata,
      arch: process.arch,
      download: async (url) => {
        const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
        if (!response.ok) throw new Error(`The Agent tool download failed: ${response.status}`)
        return Buffer.from(await response.arrayBuffer())
      },
    })
    process.stdout.write(`${result}: ${tool.name}\n`)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
