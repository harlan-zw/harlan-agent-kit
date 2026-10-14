import type { TerminalProvider } from './terminal-protocol.ts'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const preparationClaim = '/tmp/wolfstar-terminal-preparation/worktree-claim.sh'
const isolation = [
  '--die-with-parent',
  '--unshare-user',
  '--unshare-pid',
  '--unshare-ipc',
  '--unshare-cgroup',
  '--cap-drop',
  'ALL',
  '--ro-bind',
  '/',
  '/',
  '--proc',
  '/proc',
  '--dev',
  '/dev',
  '--tmpfs',
  '/run',
  '--tmpfs',
  '/tmp',
  '--tmpfs',
  '/sys/fs/cgroup',
]

async function preparePackageManagerHome(home: string) {
  let path = home
  for (const name of ['.cache', 'wolfstar-terminal', 'pnpm']) {
    path = join(path, name)
    await mkdir(path).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== 'EEXIST') throw cause
    })
    if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== path)
      throw new Error('Terminal provider state requires ordinary host directories')
  }
  return path
}

export async function prepareTerminalSandbox(options: {
  cwd: string
  executable: string
  argv: string[]
  environment: NodeJS.ProcessEnv
  writable?: string[]
  denied?: string[]
  home?: string
  preparationTool?: string
  provider?: TerminalProvider
}) {
  // node-pty establishes the controlling session. Nested setsid would break interactive terminal ownership.
  await execute('/usr/bin/bwrap', [...isolation, '/usr/bin/true'], {
    timeout: 10000,
    env: { PATH: '/usr/bin:/bin' },
  })
  const cwd = await realpath(options.cwd)
  const home = options.home ?? homedir()
  const packageManagerHome = await preparePackageManagerHome(home)
  const args = [...isolation, '--bind', cwd, cwd, '--bind', packageManagerHome, packageManagerHome]
  // Host resolver symlinks commonly enter /run. Preserve only their read-only file, never its directory.
  const resolver = await realpath('/etc/resolv.conf')
  if (resolver.startsWith('/run/') || resolver.startsWith('/tmp/'))
    args.push('--dir', dirname(resolver), '--ro-bind', resolver, resolver)
  for (const path of options.writable ?? []) {
    const canonical = await realpath(path)
    args.push('--bind', canonical, canonical)
  }
  for (const name of [
    '.codex',
    '.claude',
    '.config/opencode',
    '.local/share/opencode',
    '.local/state/opencode',
    '.cache/opencode',
    '.cache/claude',
    '.cache/claude-code',
  ]) {
    const path = join(home, name)
    const metadata = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return null
      throw cause
    })
    if (!metadata) continue
    if (!metadata.isDirectory() || (await realpath(path)) !== path) {
      throw new Error('Terminal provider state requires ordinary host directories')
    }
    args.push('--bind', path, path)
  }
  const claudeFile = join(home, '.claude.json')
  const claudeMetadata = await lstat(claudeFile).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return null
    throw cause
  })
  if (claudeMetadata) {
    if (!claudeMetadata.isFile() || (await realpath(claudeFile)) !== claudeFile)
      throw new Error('Claude state requires an ordinary host file')
    args.push('--bind', claudeFile, claudeFile)
  }
  for (const path of [
    ...(options.denied ?? []),
    join(home, '.ssh'),
    ...(options.environment.SSH_AUTH_SOCK ? [options.environment.SSH_AUTH_SOCK] : []),
    join(home, '.codex/app-server-daemon'),
    join(home, '.config/wolfstar-github-agent'),
    join(home, '.local/share/wolfstar-github-agent'),
    join(home, '.local/state/wolfstar-desktop-capacity'),
  ]) {
    const metadata = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return null
      throw cause
    })
    if (!metadata) continue
    const canonical = await realpath(path)
    // Private runtime directories are already empty. Their parents cannot host a bind target.
    if (canonical.startsWith('/run/') || canonical.startsWith('/tmp/')) continue
    const target = await lstat(canonical)
    args.push(...(target.isDirectory() ? ['--tmpfs', canonical] : ['--ro-bind', '/dev/null', canonical]))
  }
  const environment: NodeJS.ProcessEnv = {
    ...options.environment,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    PNPM_HOME: packageManagerHome,
    // pnpm layouts use either PNPM_HOME or its bin directory for updated provider launchers.
    PATH: (options.provider
      ? [join(packageManagerHome, 'bin'), packageManagerHome, options.environment.PATH ?? '/usr/bin:/bin']
      : [options.environment.PATH ?? '/usr/bin:/bin', join(packageManagerHome, 'bin'), packageManagerHome]
    ).join(':'),
  }
  if (options.preparationTool) {
    const tool = await realpath(options.preparationTool)
    if (!(await lstat(tool)).isFile()) throw new Error('Terminal preparation requires an ordinary claim tool')
    // Re-expose one immutable tool after private masks. Its host parent stays hidden.
    args.push('--dir', dirname(preparationClaim), '--ro-bind', tool, preparationClaim)
  }
  for (const name of [
    'DBUS_SESSION_BUS_ADDRESS',
    'DBUS_SYSTEM_BUS_ADDRESS',
    'SYSTEMD_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
    'SSH_AUTH_SOCK',
    'LISTEN_FDS',
    'LISTEN_PID',
    'LISTEN_FDNAMES',
    'NOTIFY_SOCKET',
  ])
    delete environment[name]
  let executable = options.executable
  if (options.provider) {
    for (const directory of [join(packageManagerHome, 'bin'), packageManagerHome]) {
      const candidate = join(directory, options.provider)
      const available = await access(candidate, constants.X_OK)
        .then(() => true)
        .catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === 'ENOENT' || cause.code === 'EACCES' || cause.code === 'ENOTDIR') return false
          throw cause
        })
      if (available) {
        executable = candidate
        break
      }
    }
  }
  args.push('--chdir', cwd, '--', executable, ...options.argv)
  return { executable: '/usr/bin/bwrap', argv: args, environment }
}

function preparationGitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rawCount = environment.GIT_CONFIG_COUNT ?? '0'
  if (!/^(?:0|[1-9]\d*)$/.test(rawCount) || !Number.isSafeInteger(Number(rawCount) + 2))
    throw new Error('Terminal preparation requires a valid Git configuration count')
  const count = Number(rawCount)
  const result: NodeJS.ProcessEnv = { ...environment, GIT_CONFIG_COUNT: String(count + 2) }
  // Worktrunk fetch hooks cannot use the host SSH identity. Existing HTTPS helpers remain available.
  for (const [offset, prefix] of ['git@github.com:', 'ssh://git@github.com/'].entries()) {
    result[`GIT_CONFIG_KEY_${count + offset}`] = 'url.https://github.com/.insteadOf'
    result[`GIT_CONFIG_VALUE_${count + offset}`] = prefix
  }
  return result
}

/** Worktrunk hooks share the provider's denied bus and cgroup boundary. */
export async function createTerminalPreparationRunner(
  project: string,
  claimScript: string,
  denied: string[],
  home = homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<typeof execute> {
  const parent = dirname(await realpath(project))
  const common = await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: project })
  const writable = [parent, common.stdout.trim(), join(home, '.local/state'), join(home, '.cache')]
  // The claim store belongs to this user. No hook can reach the user manager through /run or DBus.
  const claim = await realpath(claimScript)
  return (async (
    file: string,
    args: readonly string[],
    settings: { cwd?: string; timeout?: number; maxBuffer?: number } = {},
  ) => {
    const sandbox = await prepareTerminalSandbox({
      cwd: settings.cwd ?? project,
      executable: '/usr/bin/env',
      argv: [
        file === claimScript ? preparationClaim : file,
        ...args.map((argument, index) => (index === 0 && argument === claimScript ? preparationClaim : argument)),
      ],
      environment: preparationGitEnvironment(environment),
      writable,
      denied,
      home,
      preparationTool: claim,
    })
    return execute(sandbox.executable, sandbox.argv, {
      ...settings,
      env: sandbox.environment,
    })
  }) as typeof execute
}
