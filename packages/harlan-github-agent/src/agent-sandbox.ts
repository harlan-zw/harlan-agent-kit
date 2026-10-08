import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createAgentEgress } from './agent-egress.ts'
import { checkinEnvironment } from './checkin-environment.ts'
import { workspaceEnvironment } from './workspace-environment.ts'

const execute = promisify(execFile)
const workerHome = '/home/agent'
const workerStateHome = `${workerHome}/.local/state`

const mutableGitFiles = ['HEAD', 'index', 'ORIG_HEAD', 'MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'FETCH_HEAD', 'AUTO_MERGE', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'SQUASH_MSG', 'logs/HEAD'] as const

/** Read an ordinary Git data file without following an untrusted file or directory alias. */
async function gitData(root: string, name: string): Promise<Buffer | null> {
  const file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
  if (file === null)
    return null
  try {
    const canonicalRoot = await realpath(root)
    const path = await realpath(`/proc/self/fd/${file.fd}`)
    const metadata = await file.stat()
    const limit = name === 'index' ? 128 * 1024 * 1024 : 16 * 1024 * 1024
    if (!path.startsWith(`${canonicalRoot}/`) || !metadata.isFile() || metadata.size > limit)
      throw new Error('The Agent Git data must use bounded regular files inside its task directory.')
    const buffer = Buffer.alloc(Math.min(metadata.size + 1, limit + 1))
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
      if (bytesRead === 0)
        break
      size += bytesRead
    }
    if (size > metadata.size)
      throw new Error('The Agent Git data changed while being read.')
    return buffer.subarray(0, size)
  }
  finally {
    await file.close()
  }
}

/** Keep atomic Git writes private. Copy back only index, head and merge data, never configuration. */
async function privateGitData(scratch: string, taskDirectory: string): Promise<{ directory: string, save: () => Promise<void> }> {
  const directory = join(scratch, 'git-task')
  await mkdir(join(directory, 'logs'), { recursive: true, mode: 0o700 })
  for (const name of [...mutableGitFiles, 'commondir', 'gitdir']) {
    const data = await gitData(taskDirectory, name)
    if (data !== null)
      await writeFile(join(directory, name), data, { mode: 0o600 })
  }
  return { directory, save: async () => {
    // Parse every source before changing trusted task data.
    const data = await Promise.all(mutableGitFiles.map(async name => ({ name, value: await gitData(directory, name) })))
    const staging = await mkdtemp(join(taskDirectory, '.agent-data-'))
    try {
      for (const { name, value } of data) {
        if (value === null) {
          await rm(join(taskDirectory, name), { force: true })
        }
        else {
          await mkdir(dirname(join(staging, name)), { recursive: true, mode: 0o700 })
          await writeFile(join(staging, name), value, { mode: 0o600 })
          await mkdir(dirname(join(taskDirectory, name)), { recursive: true, mode: 0o700 })
          await rename(join(staging, name), join(taskDirectory, name))
        }
      }
    }
    finally {
      await rm(staging, { recursive: true, force: true })
    }
  } }
}

/** Copy bounded trusted refs. The worker can mutate only this disposable copy. */
async function privateGitCommon(scratch: string, common: string): Promise<string> {
  const directory = join(scratch, 'git-common')
  await mkdir(join(directory, 'objects/info'), { recursive: true, mode: 0o700 })
  await mkdir(join(directory, 'refs'), { recursive: true, mode: 0o700 })
  await writeFile(join(directory, 'objects/info/alternates'), '/run/agent/base-objects\n', { mode: 0o600 })
  let count = 0
  const copyRefs = async (name: string, depth: number): Promise<void> => {
    if (depth > 32)
      throw new Error('The Agent Git refs exceed their directory limit.')
    for (const entry of await readdir(join(common, name), { withFileTypes: true })) {
      if (++count > 20_000)
        throw new Error('The Agent Git refs exceed their file limit.')
      const relative = join(name, entry.name)
      if (entry.isDirectory()) {
        await mkdir(join(directory, relative), { mode: 0o700 })
        await copyRefs(relative, depth + 1)
      }
      else if (entry.isFile()) {
        const data = await gitData(common, relative)
        if (data === null || data.length > 64 * 1024)
          throw new Error('The Agent Git ref must use a bounded regular file.')
        await writeFile(join(directory, relative), data, { mode: 0o600 })
      }
      else {
        throw new Error('The Agent Git refs must not use file aliases.')
      }
    }
  }
  await copyRefs('refs', 0)
  for (const name of ['HEAD', 'packed-refs', 'shallow']) {
    const data = await gitData(common, name)
    if (data !== null)
      await writeFile(join(directory, name), data, { mode: 0o600 })
  }
  return directory
}

interface WorkerConfiguration {
  home: string
  tools: string[]
  readOnlyPaths: string[]
  codex: string
  opencode: string
}

export interface AgentSandbox {
  binary: string
  args: string[]
  environment: NodeJS.ProcessEnv
  /** The worker's state root, separate from the host process environment. */
  workerStateHome: string
  providerBinary: string
  adapterPath: string
  release: () => Promise<void>
}

function configuration(value: unknown): WorkerConfiguration {
  if (typeof value !== 'object' || value === null)
    throw new Error('The Agent worker configuration must contain an object.')
  const record = value as Record<string, unknown>
  for (const key of ['home', 'codex', 'opencode']) {
    if (typeof record[key] !== 'string' || !isAbsolute(record[key]))
      throw new Error(`The Agent worker ${key} path must be absolute.`)
  }
  for (const key of ['tools', 'readOnlyPaths']) {
    if (!Array.isArray(record[key]) || !record[key].every(item => typeof item === 'string' && isAbsolute(item)))
      throw new Error(`The Agent worker ${key} must contain absolute paths.`)
  }
  return record as unknown as WorkerConfiguration
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

/** Refuse broad mounts and the controller's credential stores, including symlink aliases. */
async function permittedPath(path: string, controllerHome: string): Promise<string> {
  const canonical = await realpath(path)
  const forbidden = ['.ssh', '.config', '.git-credentials', '.gitconfig', '.netrc', '.local/share/harlan-github-agent', '.codex/auth.json', '.local/share/opencode/auth.json']
  if (['/', '/home', '/root', '/tmp', '/run', '/proc', '/sys', '/etc', '/var'].includes(canonical)
    || within(controllerHome, canonical)
    || forbidden.some((suffix) => {
      const protectedPath = join(controllerHome, suffix)
      // These are tracked plugin instructions, not the adjacent Service state.
      if (suffix === '.local/share/harlan-github-agent'
        && within(canonical, join(protectedPath, 'service/harlan-agent-kit'))) {
        return false
      }
      return within(canonical, protectedPath) || within(protectedPath, canonical)
    })) {
    throw new Error(`The Agent worker mount exposes controller credentials: ${path}`)
  }
  return canonical
}

/** Trusted instruction and Skill paths, supplied by the controller rather than the repository. */
export function opencodeSandboxPaths(environment: NodeJS.ProcessEnv): string[] {
  if (environment.OPENCODE_CONFIG_CONTENT === undefined)
    return []
  const value = JSON.parse(environment.OPENCODE_CONFIG_CONTENT) as { instructions?: string[], skills?: { paths?: string[] } }
  return [...(value.instructions ?? []), ...(value.skills?.paths ?? [])]
}

/** Refuse an update before restarting a host that cannot isolate its Agents. */
export async function checkAgentWorker(environment: NodeJS.ProcessEnv, profilePath?: string): Promise<void> {
  const controllerHome = resolve(environment.HOME ?? '/home/harlan')
  const profile = configuration(JSON.parse(await readFile(profilePath ?? join(controllerHome, '.config/harlan-github-agent/worker.json'), 'utf8')))
  for (const path of [profile.home, ...profile.tools, ...profile.readOnlyPaths, profile.codex, profile.opencode])
    await permittedPath(path, controllerHome)
  for (const path of [profile.codex, profile.opencode]) {
    const metadata = await stat(path)
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0)
      throw new Error(`The Agent provider binary must be executable: ${path}`)
  }
  await execute('/usr/bin/bwrap', ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup', '--unshare-net', '--cap-drop', 'ALL', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '/usr/bin/true'], { timeout: 10_000, env: { PATH: '/usr/bin:/bin' } })
}

/**
 * Launch every tool under an allowlist mount namespace and a private process namespace.
 * The host home, credential helpers, sockets, and controller environment are absent.
 * Network traffic can leave only through the trusted public-address egress broker.
 */
export async function prepareAgentSandbox(input: {
  workspace: string
  environment: NodeJS.ProcessEnv
  profilePath?: string
  provider: 'codex' | 'opencode'
  readOnlyPaths?: readonly string[]
  writablePaths?: readonly string[]
  taskId?: string
  networkMode?: 'command' | 'opencode-server' | 'opencode-client'
  transportDirectory?: string
  readOnly?: boolean
  /** Task-owned home with only named provider login and trusted Review configuration. */
  reviewHome?: string
}): Promise<AgentSandbox> {
  const controllerHome = resolve(input.environment.HOME ?? '/home/harlan')
  const profilePath = input.profilePath ?? join(controllerHome, '.config/harlan-github-agent/worker.json')
  const profile = configuration(JSON.parse(await readFile(profilePath, 'utf8')))
  const readOnly = input.readOnly === true || input.reviewHome !== undefined
  const isolatedHome = await permittedPath(input.reviewHome ?? profile.home, controllerHome)
  if (within(controllerHome, isolatedHome) || isolatedHome === '/home' || isolatedHome === '/')
    throw new Error('The Agent worker home must not contain the controller home.')
  const scratch = await mkdtemp(join(tmpdir(), 'agent-sandbox-'))
  const egressDirectory = join(scratch, 'egress')
  await mkdir(egressDirectory, { mode: 0o700 })
  const egress = await createAgentEgress(join(egressDirectory, 'proxy.sock'))
  try {
    const args = ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup', '--unshare-net', '--cap-drop', 'ALL']
    for (const path of ['/usr', '/lib', '/lib64', '/bin', '/sbin']) {
      if (await stat(path).then(() => true).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error)))
        args.push('--ro-bind', path, path)
    }
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run', '--dir', '/etc')
    const runtime = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './agent-sandbox-runtime.ts' : '../agent-sandbox-runtime.mjs', import.meta.url))
    const adapterSource = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './agent-sandbox-cli.ts' : '../agent-sandbox-cli.mjs', import.meta.url))
    const adapterPath = join(scratch, import.meta.url.endsWith('.ts') ? 'codex-adapter.ts' : 'codex-adapter.mjs')
    await writeFile(adapterPath, `#!${process.execPath} --experimental-strip-types\n${(await readFile(adapterSource, 'utf8')).replace(/^#![^\n]*\n/, '')}`, { mode: 0o700 })
    args.push('--ro-bind', await realpath(process.execPath), '/run/agent/node', '--ro-bind', runtime, '/run/agent/runtime.ts', '--ro-bind', egressDirectory, '/run/agent/egress')
    if (input.transportDirectory !== undefined)
      args.push('--bind', input.transportDirectory, '/run/agent/transport')
    for (const path of ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/ssl/certs', '/etc/ca-certificates', '/etc/ld.so.cache']) {
      if (await stat(path).then(() => true).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error)))
        args.push('--ro-bind', path, path)
    }
    args.push('--bind', isolatedHome, workerHome)
    for (const path of [...profile.tools, ...profile.readOnlyPaths]) {
      const canonical = await permittedPath(path, controllerHome)
      args.push('--ro-bind', canonical, path)
    }
    for (const path of input.readOnlyPaths ?? []) {
      const metadata = await stat(path)
      // A memory index links to sibling notes. Grant that memory directory,
      // never its project directory, transcripts, or neighbouring databases.
      const memory = metadata.isFile() && basename(path) === 'MEMORY.md' && basename(dirname(path)) === 'memory'
      if (memory)
        args.push('--ro-bind', await permittedPath(dirname(path), controllerHome), dirname(path))
      else
        args.push('--ro-bind', await permittedPath(path, controllerHome), path)
    }
    for (const path of input.writablePaths ?? [])
      args.push('--bind', await permittedPath(path, controllerHome), path)
    const workspace = await realpath(input.workspace)
    const repositoryBind = readOnly ? '--ro-bind' : '--bind'
    args.push(repositoryBind, workspace, workspace)
    if (input.reviewHome !== undefined) {
      for (const name of ['.codex/config.toml', '.config/opencode/opencode.json']) {
        const path = join(isolatedHome, name)
        if (await stat(path).then(() => true).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error)))
          args.push('--ro-bind', path, join(workerHome, name))
      }
      // Project configuration can register another tool or plugin. Hide it before either provider starts.
      for (const name of ['.codex', '.opencode']) {
        const path = join(workspace, name)
        if (await stat(path).then(() => true).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error)))
          args.push('--tmpfs', path)
      }
      for (const name of ['opencode.json', 'opencode.jsonc']) {
        const path = join(workspace, name)
        if (await stat(path).then(() => true).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error)))
          args.push('--ro-bind', join(input.reviewHome, '.config/opencode/opencode.json'), path)
      }
    }
    const { stdout } = await execute('git', ['-C', workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    const common = await realpath(stdout.trim())
    const objects = join(common, 'objects')
    if (await realpath(objects) !== objects || !(await stat(objects)).isDirectory())
      throw new Error('The Agent host object store must use its own ordinary directory.')
    // No writable host Git storage enters the worker namespace.
    const privateCommon = await privateGitCommon(scratch, common)
    args.push(repositoryBind, privateCommon, common)
    args.push('--ro-bind', objects, '/run/agent/base-objects')
    args.push('--ro-bind', join(privateCommon, 'objects/info/alternates'), join(common, 'objects/info/alternates'))
    const taskDirectory = await execute('git', ['-C', workspace, 'rev-parse', '--path-format=absolute', '--git-dir']).then(result => realpath(result.stdout.trim()))
    if (!within(taskDirectory, join(common, 'worktrees')) || taskDirectory === join(common, 'worktrees'))
      throw new Error('The Agent worker needs a prepared linked worktree.')
    await mkdir(join(privateCommon, taskDirectory.slice(common.length + 1)), { recursive: true, mode: 0o700 })
    const privateGit = await privateGitData(scratch, taskDirectory)
    const originalHead = await gitData(taskDirectory, 'HEAD')
    if (originalHead === null || !/^ref: refs\/heads\/[^\r\n]+\n?$/.test(originalHead.toString('utf8')))
      throw new Error('The Agent worker needs an approved local Git branch.')
    const branch = originalHead.toString('utf8').trim().slice('ref: '.length)
    const originalSha = (await execute('git', ['-C', workspace, 'rev-parse', '--verify', 'HEAD'])).stdout.trim()
    args.push(repositoryBind, privateGit.directory, taskDirectory)
    // Administrative pointers remain immutable. Only explicit Git data returns to the host.
    for (const name of ['commondir', 'gitdir'])
      args.push('--ro-bind', join(privateGit.directory, name), join(taskDirectory, name))
    args.push('--ro-bind', join(workspace, '.git'), join(workspace, '.git'))
    const gitConfig = join(scratch, 'gitconfig')
    const origin = await execute('git', ['-C', workspace, 'remote', 'get-url', 'origin']).then(result => result.stdout.trim()).catch(() => '')
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(origin)
    if (origin !== '' && match === null)
      throw new Error('The Agent worker origin must use a GitHub URL without credentials.')
    const checkinValues = input.reviewHome === undefined
      ? await checkinEnvironment({ controllerHome, repository: match?.[1], taskId: input.taskId })
      : {}
    await writeFile(gitConfig, `[core]\n repositoryformatversion = 0\n bare = false\n hooksPath = /home/agent/.config/git/hooks\n${match ? `[remote "origin"]\n url = https://github.com/${match[1]}.git\n fetch = +refs/heads/*:refs/remotes/origin/*\n` : ''}`, { mode: 0o600 })
    await writeFile(join(privateCommon, 'config'), '', { mode: 0o600 })
    await writeFile(join(privateGit.directory, 'config.worktree'), '', { mode: 0o600 })
    args.push('--ro-bind', gitConfig, join(common, 'config'))
    args.push('--ro-bind', gitConfig, join(taskDirectory, 'config.worktree'))
    args.push('--chdir', workspace, '--', '/run/agent/node', '--experimental-strip-types', '/run/agent/runtime.ts', input.networkMode ?? 'command')
    const baseEnvironment: NodeJS.ProcessEnv = {
      HOME: workerHome,
      PATH: `${workerHome}/.local/share/harlan-agent-kit/github-bin:${profile.tools.join(':')}:/usr/local/bin:/usr/bin:/bin`,
      LANG: input.environment.LANG ?? 'C.UTF-8',
      ...(input.environment.CI === undefined ? {} : { CI: input.environment.CI }),
      XDG_CONFIG_HOME: `${workerHome}/.config`,
      XDG_DATA_HOME: `${workerHome}/.local/share`,
      XDG_STATE_HOME: workerStateHome,
      CODEX_HOME: `${workerHome}/.codex`,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...(input.reviewHome === undefined ? {} : { OPENCODE_DISABLE_PROJECT_CONFIG: 'true' }),
      ...(input.environment.OPENCODE_CONFIG_CONTENT === undefined ? {} : { OPENCODE_CONFIG_CONTENT: input.environment.OPENCODE_CONFIG_CONTENT }),
      ...(input.environment.OPENCODE_SERVER_USERNAME === undefined ? {} : { OPENCODE_SERVER_USERNAME: input.environment.OPENCODE_SERVER_USERNAME }),
      ...(input.environment.OPENCODE_SERVER_PASSWORD === undefined ? {} : { OPENCODE_SERVER_PASSWORD: input.environment.OPENCODE_SERVER_PASSWORD }),
    }
    // Review tools use only controller configuration. Repository loader variables can restore execution.
    const environment = {
      ...(input.reviewHome === undefined ? workspaceEnvironment(baseEnvironment, workspace, input.taskId) : baseEnvironment),
      ...checkinValues,
      // Native watcher startup can block OpenCode's event loop. Controller turns use tools to read current files.
      ...(input.provider === 'opencode' ? { OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true' } : {}),
    }
    // Repository variables belong inside the boundary. Loader variables must
    // never affect host Bubblewrap before namespace creation.
    args.splice(args.indexOf('--'), 0, '--clearenv', ...Object.entries(environment).flatMap(([key, value]) => value === undefined ? [] : ['--setenv', key, value]))
    let released: Promise<void> | undefined
    const saveGit = async () => {
      const finalHead = await gitData(privateGit.directory, 'HEAD')
      if (finalHead === null || !finalHead.equals(originalHead))
        throw new Error('The Agent changed its approved Git branch.')
      const safeGit = ['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-C', workspace]
      const exportArgs = [...args]
      exportArgs[exportArgs.lastIndexOf('/run/agent/runtime.ts') + 1] = 'command'
      const guest = [...exportArgs, ...safeGit]
      const newSha = (await execute('/usr/bin/bwrap', [...guest, 'rev-parse', '--verify', 'HEAD'], { env: { PATH: '/usr/bin:/bin' }, timeout: 30_000 })).stdout.trim()
      if (!/^[a-f0-9]{40}$/.test(newSha) || !/^[a-f0-9]{40}$/.test(originalSha))
        throw new Error('The Agent Git head must use a complete commit SHA.')
      if (newSha !== originalSha) {
        const exporting = execute('/usr/bin/bwrap', [...guest, 'pack-objects', '--stdout', '--revs', '--thin'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, timeout: 30_000 })
        exporting.child.stdin!.end(`${newSha}\n^${originalSha}\n`)
        const pack = (await exporting).stdout
        // Host Git reads only a pack stream. It never reads worker configuration or aliases.
        const importing = execute('/usr/bin/git', [...safeGit.slice(1), 'index-pack', '--stdin', '--fix-thin'], { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'buffer', maxBuffer: 1024 * 1024, timeout: 30_000 })
        importing.child.stdin!.end(pack)
        await importing
      }
      await execute('/usr/bin/git', [...safeGit.slice(1), 'update-ref', branch, newSha, originalSha], { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, timeout: 30_000 })
      await privateGit.save()
    }
    return { binary: '/usr/bin/bwrap', args, environment: { PATH: '/usr/bin:/bin' }, workerStateHome, adapterPath, providerBinary: profile[input.provider], release: () => {
      released ??= (async () => {
        try {
          if (!readOnly)
            await saveGit()
        }
        finally {
          try {
            await egress.close()
          }
          finally {
            await rm(scratch, { recursive: true, force: true })
          }
        }
      })()
      return released
    } }
  }
  catch (error) {
    await egress.close()
    await rm(scratch, { recursive: true, force: true })
    throw error
  }
}

/** Run repository checks through the same boundary used by implementation Agents. */
export async function runAgentSandboxCommand(input: {
  workspace: string
  command: string
  args: string[]
  signal: AbortSignal
  environment: NodeJS.ProcessEnv
  profilePath?: string
  readOnlyPaths?: readonly string[]
  writablePaths?: readonly string[]
}): Promise<{ exitCode: number, stdout: string, stderr: string }> {
  const sandbox = await prepareAgentSandbox({ ...input, provider: 'codex' })
  try {
    return await execute(sandbox.binary, [...sandbox.args, input.command, ...input.args], {
      cwd: input.workspace,
      env: sandbox.environment,
      signal: input.signal,
      maxBuffer: 10 * 1024 * 1024,
    }).then(result => ({ exitCode: 0, ...result })).catch((error: Error & { code?: string | number, stdout: string, stderr: string }) => {
      if (typeof error.code === 'number')
        return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr }
      throw error
    })
  }
  finally {
    await sandbox.release()
  }
}
