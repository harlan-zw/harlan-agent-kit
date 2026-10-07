import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createAgentEgress } from './agent-egress.ts'
import { workspaceEnvironment } from './workspace-environment.ts'

const execute = promisify(execFile)
const workerHome = '/home/agent'

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
    const workspace = await realpath(input.workspace)
    const repositoryBind = input.readOnly === true || input.reviewHome !== undefined ? '--ro-bind' : '--bind'
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
    // Share only Git's object/ref storage and this task's index. Never expose
    // the common directory's host config, other tasks, hooks, or extra files.
    args.push('--tmpfs', common)
    for (const name of ['HEAD', 'objects', 'refs', 'logs', 'packed-refs', 'shallow']) {
      const path = join(common, name)
      if (await stat(path).then(() => true).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error)))
        args.push(repositoryBind, path, path)
    }
    const taskDirectory = await execute('git', ['-C', workspace, 'rev-parse', '--path-format=absolute', '--git-dir']).then(result => realpath(result.stdout.trim()))
    if (taskDirectory === common)
      throw new Error('The Agent worker needs a prepared linked worktree.')
    args.push(repositoryBind, taskDirectory, taskDirectory)
    // Git metadata is shared with publication. Hide its host helpers and hooks.
    const gitConfig = join(scratch, 'gitconfig')
    const origin = await execute('git', ['-C', workspace, 'remote', 'get-url', 'origin']).then(result => result.stdout.trim()).catch(() => '')
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(origin)
    if (origin !== '' && match === null)
      throw new Error('The Agent worker origin must use a GitHub URL without credentials.')
    await writeFile(gitConfig, `[core]\n repositoryformatversion = 0\n bare = false\n hooksPath = /home/agent/.config/git/hooks\n${match ? `[remote "origin"]\n url = https://github.com/${match[1]}.git\n fetch = +refs/heads/*:refs/remotes/origin/*\n` : ''}`, { mode: 0o600 })
    args.push('--ro-bind', gitConfig, join(common, 'config'))
    if (taskDirectory !== common) {
      const worktreeConfig = join(taskDirectory, 'config.worktree')
      if (await stat(worktreeConfig).then(() => true).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error)))
        args.push('--ro-bind', gitConfig, worktreeConfig)
    }
    args.push('--chdir', workspace, '--', '/run/agent/node', '--experimental-strip-types', '/run/agent/runtime.ts', input.networkMode ?? 'command')
    const environment = workspaceEnvironment({
      HOME: workerHome,
      PATH: `${workerHome}/.local/share/harlan-agent-kit/github-bin:${profile.tools.join(':')}:/usr/local/bin:/usr/bin:/bin`,
      LANG: input.environment.LANG ?? 'C.UTF-8',
      XDG_CONFIG_HOME: `${workerHome}/.config`,
      XDG_DATA_HOME: `${workerHome}/.local/share`,
      XDG_STATE_HOME: `${workerHome}/.local/state`,
      CODEX_HOME: `${workerHome}/.codex`,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...(input.reviewHome === undefined ? {} : { OPENCODE_DISABLE_PROJECT_CONFIG: 'true' }),
      ...(input.environment.OPENCODE_CONFIG_CONTENT === undefined ? {} : { OPENCODE_CONFIG_CONTENT: input.environment.OPENCODE_CONFIG_CONTENT }),
      ...(input.environment.OPENCODE_SERVER_USERNAME === undefined ? {} : { OPENCODE_SERVER_USERNAME: input.environment.OPENCODE_SERVER_USERNAME }),
      ...(input.environment.OPENCODE_SERVER_PASSWORD === undefined ? {} : { OPENCODE_SERVER_PASSWORD: input.environment.OPENCODE_SERVER_PASSWORD }),
    }, workspace, input.taskId)
    // Repository variables belong inside the boundary. Loader variables must
    // never affect host Bubblewrap before namespace creation.
    args.splice(args.indexOf('--'), 0, '--clearenv', ...Object.entries(environment).flatMap(([key, value]) => value === undefined ? [] : ['--setenv', key, value]))
    let released: Promise<void> | undefined
    return { binary: '/usr/bin/bwrap', args, environment: { PATH: '/usr/bin:/bin' }, adapterPath, providerBinary: profile[input.provider], release: () => {
      released ??= egress.close().then(() => rm(scratch, { recursive: true, force: true }))
      return released
    } }
  }
  catch (error) {
    await egress.close()
    await rm(scratch, { recursive: true, force: true })
    throw error
  }
}
