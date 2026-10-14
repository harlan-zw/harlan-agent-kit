#!/usr/bin/env -S node --experimental-strip-types
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
      new RegExp(`^codex-${arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl\\.tar\\.gz$`),
  },
  {
    name: 'opencode',
    repository: 'anomalyco/opencode',
    asset: (arch: string) => new RegExp(`^opencode-linux-${arch === 'arm64' ? 'arm64' : 'x64-baseline'}\\.tar\\.gz$`),
  },
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

/** Parse stable release metadata before using its archive or download URL. */
export function agentToolRelease(
  value: unknown,
  tool: (typeof managedTools)[number],
  arch: string,
): { tag: string; asset: ReleaseAsset } {
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
  const previous = await readFile(receipt, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (previous !== undefined) {
    const record = JSON.parse(previous) as { digest?: string }
    if (
      record.digest === release.asset.digest &&
      (await stat(binary)
        .then((metadata) => metadata.isFile() && (metadata.mode & 0o111) !== 0)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false
          throw error
        }))
    ) {
      return 'Current'
    }
  }
  const bytes = await input.download(release.asset.browser_download_url)
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== release.asset.digest)
    throw new Error(`The Agent tool archive checksum differs: ${input.tool.name}`)
  const scratch = await mkdtemp(join(tmpdir(), 'agent-tool-'))
  await mkdir(join(root, 'bin'), { recursive: true, mode: 0o700 })
  const staged = `${binary}.${randomUUID()}`
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
    const executableName = input.tool.name === 'codex' ? release.asset.name.replace(/\.tar\.gz$/, '') : input.tool.name
    const candidates = members.filter((member) => member === executableName || member.endsWith(`/${executableName}`))
    const member = candidates[0]
    if (candidates.length !== 1 || member === undefined || member.startsWith('/') || member.split('/').includes('..'))
      throw new Error(`The Agent tool archive has no unique executable: ${input.tool.name}`)
    const contents = (
      await execute(
        zip ? '/usr/bin/unzip' : '/usr/bin/tar',
        zip ? ['-p', archive, member] : ['-xOf', archive, member],
        { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
      )
    ).stdout
    if (contents.subarray(0, 4).toString('hex') !== '7f454c46')
      throw new Error(`The Agent tool archive must contain a native executable: ${input.tool.name}`)
    await writeFile(staged, contents, { mode: 0o700 })
    await execute(staged, ['--version'], { timeout: 30_000 })
    await chmod(staged, 0o755)
    await rename(staged, binary)
    const stagedReceipt = join(scratch, 'receipt.json')
    await writeFile(stagedReceipt, JSON.stringify({ tag: release.tag, digest: release.asset.digest }), { mode: 0o600 })
    // The receipt lives on the same filesystem as the installed executable.
    await writeFile(`${staged}.json`, await readFile(stagedReceipt), { mode: 0o600 })
    await rename(`${staged}.json`, receipt)
    return 'Updated'
  } finally {
    await rm(staged, { force: true })
    await rm(`${staged}.json`, { force: true })
    await rm(scratch, { recursive: true, force: true })
  }
}

async function main() {
  if (process.platform !== 'linux') throw new Error('Agent tool sync requires Linux.')
  const home = resolve(process.env.HOME!)
  for (const tool of managedTools) {
    const metadata = await execute(
      join(home, '.local/bin/agent-gh'),
      ['api', `repos/${tool.repository}/releases/latest`],
      { timeout: 30_000 },
    )
    const result = await syncAgentTool({
      home,
      tool,
      release: JSON.parse(metadata.stdout),
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
