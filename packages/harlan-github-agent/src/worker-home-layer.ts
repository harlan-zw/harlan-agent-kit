import type { Stats } from 'node:fs'
import type { CodexKit } from './worker-codex-kit.ts'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { dailyCheckinDirectory } from './workspace-environment.ts'

const execute = promisify(execFile)
const workerHome = '/home/agent'
const layerParent = ['.local', 'share', 'harlan-github-agent', 'agent-home-layers'] as const

export type HomeOverlaySupport = { _tag: 'Supported' } | { _tag: 'Unsupported', reason: string }

/**
 * Shared home paths whose writes outlast one turn. Every other home write
 * lands in the turn's own layer and disappears when the sandbox is released.
 */
export const PERSISTED_HOME_PATHS = [
  // Provider login refresh, sessions, and state databases. Masks below replace what Codex loads as configuration.
  '.codex',
  '.local/share/opencode',
  // Package and browser caches that keep turns fast.
  '.local/share/pnpm/store',
  '.cache/pnpm',
  '.npm/_cacache',
  '.bun/install/cache',
  '.cargo/registry',
  '.cargo/git',
  '.cache/ms-playwright',
  '.dev-browser',
  // pnpm versions that a repository's `packageManager` selects, and Rust toolchains.
  '.local/share/pnpm/package-manager-store',
  '.rustup',
  // The browser setup receipt and the lock that serializes setup across turns.
  '.local/state/harlan-agent-kit',
] as const

/** Codex reads these as configuration, instructions, or code. Each turn gets its own copy. */
const codexFileMasks = ['config.toml', '.env', 'AGENTS.override.md', 'AGENTS.md', 'hooks.json'] as const
const codexDirectoryMasks = ['plugins', 'skills', 'rules', 'prompts', 'shell_snapshots', 'agents'] as const

/** Opens each component without following an alias, creates missing ones, and returns the canonical directory. */
async function privateDirectory(root: string, components: readonly string[]): Promise<string> {
  let parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    for (const component of components) {
      if (component === '' || component === '.' || component === '..' || component.includes('/'))
        throw new Error('The Agent worker home path must use plain directory names.')
      const path = `/proc/self/fd/${parent.fd}/${component}`
      await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST')
          throw error
      })
      const child = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ELOOP' || error.code === 'ENOTDIR')
          throw new Error(`The Agent worker home must keep ${components.join('/')} as a directory without aliases.`)
        throw error
      })
      await parent.close()
      parent = child
    }
    return await realpath(`/proc/self/fd/${parent.fd}`)
  }
  finally {
    await parent.close()
  }
}

/** The kernel leaves `work/work` without permissions, and a turn can leave read-only directories in its layer. */
async function grantRemoval(directory: string): Promise<void> {
  await chmod(directory, 0o700)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory())
      await grantRemoval(join(directory, entry.name))
  }
}

async function removeLayer(path: string): Promise<void> {
  await chmod(join(path, 'work/work'), 0o700).catch((error: NodeJS.ErrnoException) => {
    // A layer that never mounted has no kernel work directory.
    if (error.code !== 'ENOENT')
      throw error
  })
  await rm(path, { recursive: true, force: true }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EACCES' && error.code !== 'EPERM')
      throw error
    await grantRemoval(path)
    await rm(path, { recursive: true, force: true })
  })
}

function systemMounts(): string[] {
  return ['--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev']
}

/** Mounts one tiny overlay on the same filesystem as real home layers. */
export async function probeHomeOverlay(controllerHome: string): Promise<HomeOverlaySupport> {
  const root = await privateDirectory(controllerHome, [...layerParent, `probe-${randomUUID()}`])
  try {
    await Promise.all(['lower', 'upper', 'work'].map(name => mkdir(join(root, name), { mode: 0o700 })))
    await execute('/usr/bin/bwrap', ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-net', '--cap-drop', 'ALL', ...systemMounts(), '--overlay-src', join(root, 'lower'), '--overlay', join(root, 'upper'), join(root, 'work'), workerHome, '/usr/bin/true'], { timeout: 10_000, env: { PATH: '/usr/bin:/bin' } })
    return { _tag: 'Supported' }
  }
  catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: unknown }
    const detail = (typeof failure.stderr === 'string' && failure.stderr.trim() !== '' ? failure.stderr.trim().split('\n')[0]! : failure.message).slice(0, 200)
    return { _tag: 'Unsupported', reason: `Agent turns need bubblewrap 0.10 or later, with overlay mounts, for the worker home (${detail}).` }
  }
  finally {
    await removeLayer(root)
  }
}

// One success per process is enough. A refusal probes again, so a host upgraded in place recovers without a restart.
let overlayConfirmed = false

export async function homeOverlaySupport(controllerHome: string): Promise<HomeOverlaySupport> {
  if (overlayConfirmed)
    return { _tag: 'Supported' }
  const support = await probeHomeOverlay(controllerHome)
  overlayConfirmed = support._tag === 'Supported'
  return support
}

/** Routine records that later runs of the same Routine read. */
function routineStatePaths(taskId: string | undefined): string[] {
  const checkin = dailyCheckinDirectory({ XDG_STATE_HOME: `${workerHome}/.local/state` }, taskId)
  const sentry = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][\w.-]*:sentry-checkin:/i.test(taskId ?? '')
  return [
    ...(checkin === undefined ? [] : [checkin.slice(workerHome.length + 1)]),
    ...(sentry ? ['.local/state/sentry-checkin'] : []),
  ]
}

async function entry(path: string): Promise<Stats | null> {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
}

/** Creates one bwrap mount point on purpose, so no alias left by an older turn decides where a mask lands. */
async function maskPoint(path: string, name: string, kind: 'File' | 'Directory'): Promise<void> {
  const ordinary = (metadata: Stats | null) => metadata !== null && (kind === 'File' ? metadata.isFile() : metadata.isDirectory())
  const current = await entry(path)
  if (ordinary(current))
    return
  if (current?.isDirectory())
    throw new Error(`The Agent worker home has a directory where Codex expects the file .codex/${name}.`)
  // An alias or special file here predates the home layer. Replace it with an ordinary mount point.
  if (current !== null) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT')
        throw error
    })
  }
  // A rollback to code without masks reads these stubs. Codex warns on an empty hooks file.
  const created = kind === 'File'
    ? writeFile(path, name === 'hooks.json' ? '{}' : '', { flag: 'wx', mode: 0o600 })
    : mkdir(path, { mode: 0o700 })
  // Turns that start together create the same mount point. Keep the other turn's entry when its type matches.
  await created.catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST')
      throw error
  })
  if (!ordinary(await entry(path)))
    throw new Error(`The Agent worker home must keep .codex/${name} as an ordinary ${kind === 'File' ? 'file' : 'directory'}.`)
}

async function prepareCodexMasks(codex: string): Promise<string> {
  const directory = await open(codex, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const pinned = `/proc/self/fd/${directory.fd}`
    for (const name of codexFileMasks)
      await maskPoint(`${pinned}/${name}`, name, 'File')
    for (const name of codexDirectoryMasks)
      await maskPoint(`${pinned}/${name}`, name, 'Directory')
    return await boundedFile(`${pinned}/AGENTS.md`)
  }
  finally {
    await directory.close()
  }
}

async function boundedFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size > 1024 * 1024)
      throw new Error('The Agent worker Codex instructions must use a bounded regular file.')
    const buffer = Buffer.alloc(metadata.size)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  }
  finally {
    await file.close()
  }
}

/**
 * Swaps the turn layer for a fresh in-memory one. A helper that runs beside the
 * sandbox's main process needs this: two live mounts of one layer break each other's writes.
 */
export function besideHomeLayer(args: readonly string[]): string[] {
  const index = args.indexOf('--overlay')
  if (index === -1 || args[index + 3] !== workerHome)
    return [...args]
  return [...args.slice(0, index), '--tmp-overlay', workerHome, ...args.slice(index + 4)]
}

export interface HomeLayer {
  /** Mounts for `/home/agent`, in order: the overlay, the persisted paths, then the Codex masks. */
  args: string[]
  /** Removes the turn's layer. A failed removal is logged, never thrown. */
  release: () => Promise<void>
}

/**
 * Reads come from the shared home, so caches stay warm. Writes outside the
 * persisted paths land in a layer owned by this sandbox and last one turn.
 */
export async function prepareHomeLayer(input: {
  controllerHome: string
  sharedHome: string
  taskId?: string
  /** The kit Codex Skills and guards, from a trusted read-only mount. */
  codexKit?: CodexKit
}): Promise<HomeLayer> {
  const layer = await privateDirectory(input.controllerHome, [...layerParent, randomUUID()])
  let released: Promise<void> | undefined
  const release = () => {
    released ??= removeLayer(layer).catch((error: unknown) => {
      // The turn already finished. A leftover layer costs disk space, never isolation.
      console.error(`The Agent turn's home writes were not removed: ${layer}`, error instanceof Error ? error.message : String(error))
    })
    return released
  }
  try {
    await Promise.all(['upper', 'work', 'codex'].map(name => mkdir(join(layer, name), { mode: 0o700 })))
    const persisted: Array<{ path: string, source: string }> = []
    for (const path of [...PERSISTED_HOME_PATHS, ...routineStatePaths(input.taskId)]) {
      const source = await privateDirectory(input.sharedHome, path.split('/'))
      if (source !== join(input.sharedHome, path))
        throw new Error(`The Agent worker home must keep ${path} inside itself.`)
      persisted.push({ path, source })
    }
    const instructions = await prepareCodexMasks(join(input.sharedHome, '.codex'))
    const codex = join(layer, 'codex')
    const kit = input.codexKit
    await Promise.all([
      // Codex may record project trust during the turn. Those writes stay in this copy.
      writeFile(join(codex, 'config.toml'), '', { mode: 0o600 }),
      writeFile(join(codex, 'empty'), '', { mode: 0o400 }),
      writeFile(join(codex, 'hooks.json'), '{}', { mode: 0o400 }),
      writeFile(join(codex, 'AGENTS.md'), instructions, { mode: 0o400 }),
    ])
    const args = ['--overlay-src', input.sharedHome, '--overlay', join(layer, 'upper'), join(layer, 'work'), workerHome]
    for (const { path, source } of persisted)
      args.push('--bind', source, `${workerHome}/${path}`)
    args.push(
      '--bind',
      join(codex, 'config.toml'),
      `${workerHome}/.codex/config.toml`,
      '--ro-bind',
      join(codex, 'empty'),
      `${workerHome}/.codex/.env`,
      '--ro-bind',
      join(codex, 'empty'),
      `${workerHome}/.codex/AGENTS.override.md`,
      '--ro-bind',
      join(codex, 'hooks.json'),
      `${workerHome}/.codex/hooks.json`,
      '--ro-bind',
      join(codex, 'AGENTS.md'),
      `${workerHome}/.codex/AGENTS.md`,
    )
    for (const name of codexDirectoryMasks)
      args.push('--tmpfs', `${workerHome}/.codex/${name}`)
    if (kit !== undefined) {
      // User Skills need no Codex plugin. With plugins on, Codex downloads account plugins in every turn.
      args.push('--ro-bind', kit.skills, `${workerHome}/.codex/skills/${kit.name}`)
      // Codex runs hooks from its system layer without a stored trust, and a turn cannot change them.
      const system = join(layer, 'codex-system')
      await mkdir(system, { mode: 0o700 })
      await Promise.all([
        writeFile(join(system, 'config.toml'), '', { mode: 0o400 }),
        writeFile(join(system, 'hooks.json'), kit.hooks, { mode: 0o400 }),
      ])
      args.push('--ro-bind', system, '/etc/codex')
    }
    return { args, release }
  }
  catch (error) {
    await release()
    throw error
  }
}
