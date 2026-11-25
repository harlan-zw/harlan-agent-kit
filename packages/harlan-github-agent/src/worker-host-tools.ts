import { constants } from 'node:fs'
import { access, open, readdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import process from 'node:process'

export const workerToolNames = ['gh', 'bun', 'wt', 'rg', 'fd', 'codex', 'opencode', 'agy'] as const

/** Only controller-owned installation directories may supply Agent executables. */
export async function resolveWorkerHostTools(home: string, directories: readonly string[]): Promise<Record<string, string>> {
  const tools: Record<string, string> = {}
  const trusted = [...new Set([
    join(home, '.local/share/harlan-agent-kit/tools/bin'),
    join(home, '.local/bin'),
    join(home, '.local/share/pnpm'),
    join(home, '.bun/bin'),
    join(home, '.cargo/bin'),
    join(home, '.opencode/bin'),
    ...directories,
  ])]
  for (const name of workerToolNames) {
    for (const directory of trusted) {
      const path = join(directory, name)
      const available = await access(path, constants.X_OK).then(() => true).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES')
          return false
        throw error
      })
      if (!available)
        continue
      let binary = await realpath(path)
      if (name === 'codex') {
        // pnpm's shell shim points at JavaScript. The namespace needs the native executable.
        const file = await open(binary, 'r')
        const shim = await file.read({ buffer: Buffer.alloc(65536) }).then(result => result.buffer.subarray(0, result.bytesRead)).finally(() => file.close())
        if (shim.subarray(0, 2).toString() === '#!') {
          const target = /^# cmd-shim-target=(\/[^\r\n]+)$/m.exec(shim.toString())?.[1]
          if (target === undefined)
            continue
          const platform = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`
          const packageRoot = dirname(dirname(target))
          const candidates = [
            join(packageRoot, 'vendor', platform, 'bin/codex'),
            join(packageRoot, 'vendor', platform, 'codex/codex'),
            join(packageRoot, '..', `codex-linux-${process.arch}`, 'vendor', platform, 'codex/codex'),
          ]
          let native: string | undefined
          for (const candidate of candidates) {
            if (await access(candidate, constants.X_OK).then(() => true).catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT')
                return false
              throw error
            })) {
              native = await realpath(candidate)
              break
            }
          }
          if (native === undefined)
            throw new Error(`The installed Codex native executable is missing: ${target}`)
          binary = native
        }
        const host = join(dirname(binary), 'codex-code-mode-host')
        await access(host, constants.X_OK).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES')
            throw new Error(`The installed Codex command host is missing: ${host}`)
          throw error
        })
        tools['codex-code-mode-host'] = await realpath(host)
      }
      tools[name] = binary
      break
    }
  }
  return tools
}

/** A pnpm global package directory. Every pnpm upgrade replaces the hashed segment. */
const PNPM_PACKAGE = /\/pnpm\/global\/v\d+\/[^/]+\/node_modules\/pnpm$/

/** Whether a worker read-only path names a pnpm global package directory. */
export function isPnpmPackagePath(path: string): boolean {
  return PNPM_PACKAGE.test(path)
}

/**
 * The pnpm package directory the installed shim runs today, or undefined.
 *
 * A worker profile records this path once, so a pnpm upgrade would leave it
 * pointing at a deleted directory and refuse every deploy.
 */
export async function resolvePnpmPackage(home: string, directories: readonly string[]): Promise<string | undefined> {
  const trusted = [...new Set([join(home, '.local/share/pnpm/bin'), join(home, '.local/share/pnpm'), join(home, '.local/bin'), ...directories])]
  for (const directory of trusted) {
    const shim = join(directory, 'pnpm')
    const binary = await realpath(shim).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES')
        return undefined
      throw error
    })
    if (binary === undefined)
      continue
    const file = await open(binary, 'r')
    const head = await file.read({ buffer: Buffer.alloc(65536) }).then(result => result.buffer.subarray(0, result.bytesRead).toString()).finally(() => file.close())
    const target = /^# cmd-shim-target=(\/[^\r\n]+)$/m.exec(head)?.[1] ?? binary
    const candidate = dirname(target)
    if (!isPnpmPackagePath(candidate))
      continue
    const present = await access(candidate).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        return false
      throw error
    })
    if (present)
      return candidate
  }
  return undefined
}

/** pnpm writes this file beside each native shim. It holds the absolute path that the shim runs. */
const PNPM_SHIM_TARGET = /^\.pnpm-shim-v1-.+-target$/

/** A file of one top-level package in one pnpm global install: the install, then the package name. */
const PNPM_GLOBAL_PACKAGE_FILE = /^(\/.+\/pnpm\/global\/v\d+\/[^/]+)\/node_modules\/([^/.@][^/]*)\/[^/]/

/** The runtime names that a pnpm global install manifest declares in `engines.runtime`. */
function declaredRuntimes(manifest: string): string[] {
  let value: unknown
  try {
    value = JSON.parse(manifest)
  }
  catch (error) {
    // pnpm owns this file. An unreadable manifest proves no runtime, so the Agent gets no extra mount.
    if (error instanceof SyntaxError)
      return []
    throw error
  }
  const runtime = (value as { engines?: { runtime?: unknown } } | null)?.engines?.runtime
  return [runtime].flat().flatMap(item => typeof item === 'object' && item !== null && 'name' in item && typeof item.name === 'string' ? [item.name] : [])
}

/**
 * The pnpm managed runtime packages that native pnpm shims in these directories run.
 *
 * A native shim, such as pnpm's `node`, runs the path in its sibling target file.
 * That path names a pnpm global install by a hashed alias, outside every tool directory.
 * Each result keeps the path as the shim names it, so a mount there serves the shim.
 */
export async function resolvePnpmRuntimePackages(directories: readonly string[]): Promise<string[]> {
  const packages = new Set<string>()
  for (const directory of new Set(directories)) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES')
        return []
      throw error
    })
    for (const entry of entries) {
      if (!entry.isFile() || !PNPM_SHIM_TARGET.test(entry.name))
        continue
      const target = (await readFile(join(directory, entry.name), 'utf8')).trim()
      const match = PNPM_GLOBAL_PACKAGE_FILE.exec(target)
      const install = match?.[1]
      const name = match?.[2]
      if (install === undefined || name === undefined || normalize(target) !== target)
        continue
      const manifest = await readFile(join(install, 'package.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES')
          return undefined
        throw error
      })
      // Only a runtime install qualifies. Other global packages keep their own mounts.
      if (manifest === undefined || !declaredRuntimes(manifest).includes(name))
        continue
      const runtime = join(install, 'node_modules', name)
      const present = await access(runtime).then(() => true).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
          return false
        throw error
      })
      if (present)
        packages.add(runtime)
    }
  }
  return [...packages]
}
