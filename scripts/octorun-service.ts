import type { JsonObject, JsonValue, Result } from '../packages/octorun/src/control.ts'
import { execFile, spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parseKitServiceConfig } from '../packages/octorun/src/config.ts'
import { openStore, requestControl } from '../packages/octorun/src/control.ts'

const UNIT = 'harlan-octorun.service'
const unitOwner = '# Managed by Harlan Agent Kit Octorun.'
const shaPattern = /^[a-f0-9]{40}$/

type Action = 'install' | 'update' | 'restart' | 'stop' | 'status' | 'recover'
export interface ServiceOptions {
  action: Action
  ref: string
  repository: string
  home: string
  root: string
  stateDir: string
  configurationPath: string
  unitPath: string
  node: string
  pnpm: string
  model: string
  env: NodeJS.ProcessEnv
}
interface Execution { code: number, stdout: string }
export interface ServiceDependencies {
  exec: (command: string, args: string[], options: { cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number }) => Promise<Execution>
  control: (command: string, args: JsonObject) => Promise<Result<JsonValue> | null>
  restorePause: (paused: boolean) => Promise<void>
  readPause: () => Promise<boolean>
  lock: () => Promise<() => Promise<void>>
  wait: (milliseconds: number) => Promise<void>
}
interface Transition {
  version: 1
  prior: { release: string | null, unit: string | null, enabled: boolean, active: boolean, paused: boolean }
  next: string
}

const ok = <T>(value: T): Result<T> => ({ _tag: 'Ok', value })
const invalid = (message: string): Result<never> => ({ _tag: 'Err', error: { _tag: 'Configuration', message } })
const object = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === 'object' && !Array.isArray(input)
const inside = (parent: string, path: string): boolean => relative(parent, path) === '' || (!relative(parent, path).startsWith(`..${sep}`) && relative(parent, path) !== '..' && !isAbsolute(relative(parent, path)))
const cli = (release: string): string => join(release, 'packages/octorun/dist/cli.mjs')
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return false
    throw error
  })
}

export function serviceOptions(action: Action, overrides: Partial<Omit<ServiceOptions, 'action'>> = {}): ServiceOptions {
  const env = overrides.env ?? process.env
  const home = overrides.home ?? homedir()
  const root = overrides.root ?? env.HARLAN_OCTORUN_HOME ?? join(env.XDG_DATA_HOME ?? join(home, '.local/share'), 'harlan-octorun')
  const node = overrides.node ?? process.execPath
  return {
    action,
    ref: overrides.ref ?? 'origin/main',
    repository: overrides.repository ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    home,
    root,
    stateDir: overrides.stateDir ?? env.OCTORUN_KIT_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, '.local/state'), 'octorun-kit'),
    configurationPath: overrides.configurationPath ?? env.HARLAN_OCTORUN_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'harlan-github-agent/config.yml'),
    unitPath: overrides.unitPath ?? join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'systemd/user', UNIT),
    node,
    pnpm: overrides.pnpm ?? 'pnpm',
    model: overrides.model ?? env.OCTORUN_KIT_MODEL ?? 'claude-opus-5-5',
    env: { ...env, HOME: home, PATH: `${dirname(node)}:${join(home, '.local/bin')}:/usr/local/bin:/usr/bin:/bin`, HARLAN_OCTORUN_HOME: root },
  }
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`
}

export function renderServiceUnit(options: ServiceOptions, selectedRelease = join(options.root, 'current')): Result<string> {
  if ([options.home, options.root, options.stateDir, options.configurationPath, options.node, options.repository, options.unitPath, selectedRelease].some(path => !isAbsolute(path) || path.trim() !== path || [...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) || [...options.model].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    return invalid('Service paths must be absolute and contain no control characters.')
  if (options.root === options.home || dirname(options.root) === options.root)
    return invalid('Use a dedicated service directory beneath the home or data directory.')
  if (options.root.split(sep).includes('node_modules'))
    return invalid('Choose a service release directory outside node_modules.')
  return ok(`${unitOwner}
[Unit]
Description=Octorun workflows for Harlan Agent Kit
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${selectedRelease.replaceAll('%', '%%')}
Environment=${quote(`HOME=${options.home}`)}
Environment=${quote(`PATH=${options.env.PATH}`)}
Environment=${quote(`HARLAN_OCTORUN_HOME=${options.root}`)}
Environment=${quote(`HARLAN_OCTORUN_CONFIG=${options.configurationPath}`)}
Environment=${quote(`OCTORUN_KIT_STATE_DIR=${options.stateDir}`)}
Environment=${quote(`OCTORUN_KIT_MODEL=${options.model}`)}
ExecStartPre=:${quote(options.node)} --experimental-strip-types ${quote(join(selectedRelease, 'scripts/octorun-service.ts'))} recover
ExecStart=:${quote(options.node)} ${quote(cli(selectedRelease))} serve --config ${quote(options.configurationPath)}
UMask=0077
Restart=on-failure
RestartSec=5s
KillMode=control-group
TimeoutStartSec=60s
TimeoutStopSec=30s

[Install]
WantedBy=default.target
`)
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid()))
    throw new Error('The service directory must be owned by this user.')
  await chmod(path, 0o700)
}

async function privateStateDirectory(path: string): Promise<void> {
  await privateDirectory(path)
  for (const suffix of ['', '-wal', '-shm', '.lock']) {
    const file = join(path, `state.sqlite${suffix}`)
    if (!await exists(file))
      continue
    const info = await lstat(file)
    if (!info.isFile() || (typeof process.getuid === 'function' && info.uid !== process.getuid()))
      throw new Error('Octorun state files must be owned regular files, without symbolic links.')
    await chmod(file, 0o600)
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(contents)
    await file.sync()
  }
  finally {
    await file.close()
  }
  await rename(temporary, path)
  await syncDirectory(dirname(path))
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  await directory.sync().finally(() => directory.close())
}

async function optionalText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
}

async function canonicalFuture(path: string): Promise<string> {
  return realpath(path).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT')
      throw error
    return join(await canonicalFuture(dirname(path)), basename(path))
  })
}

async function stateBoundary(options: ServiceOptions): Promise<Result<void>> {
  const parsed = parseKitServiceConfig(await readFile(options.configurationPath, 'utf8'))
  if (parsed._tag === 'Err')
    return parsed
  const [state, root, checkout, legacy] = await Promise.all([canonicalFuture(options.stateDir), canonicalFuture(options.root), realpath(parsed.value.repository.checkout), realpath(dirname(parsed.value.storagePath))])
  if (root.split(sep).includes('node_modules'))
    return invalid('Choose a service release directory outside node_modules.')
  if ([checkout, legacy].some(path => inside(path, state) || inside(state, path) || inside(path, root) || inside(root, path)) || inside(root, state) || inside(state, root))
    return invalid('Octorun state must remain outside release, checkout, and existing Service database directories.')
  return ok(undefined)
}

async function fileLock(path: string, node: string): Promise<() => Promise<void>> {
  const child = spawn('flock', ['--nonblock', path, node, '--input-type=module-typescript', '-e', 'process.stdout.write("locked\\n"); process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const ended = new Promise<void>(resolveEnd => child.once('close', () => resolveEnd()))
  await new Promise<void>((resolveLock, reject) => {
    child.once('error', reject)
    child.once('close', () => reject(new Error('Another Octorun service operation holds the lock.')))
    child.stdout.once('data', () => resolveLock())
  })
  return async () => {
    child.stdin.end()
    await ended
  }
}

function defaults(options: ServiceOptions): ServiceDependencies {
  const execute = promisify(execFile)
  return {
    exec: async (command, args, execution) => execute(command, args, { cwd: execution.cwd, env: execution.env, encoding: 'utf8', timeout: execution.timeoutMs, maxBuffer: 4 * 1024 * 1024 }).then(result => ({ code: 0, stdout: result.stdout })).catch((error: { code?: unknown, stdout?: unknown }) => {
      if (typeof error.code === 'number')
        return { code: error.code, stdout: typeof error.stdout === 'string' ? error.stdout : '' }
      throw new Error('An Octorun service tool could not complete its operation.')
    }),
    control: (command, args) => requestControl({ path: join(options.stateDir, 'control.sock'), command, args, timeoutMs: command === 'drain' ? 900000 : 5000 }),
    readPause: async () => {
      if (!await exists(join(options.stateDir, 'state.sqlite')))
        return false
      const store = openStore({ path: join(options.stateDir, 'state.sqlite') })
      try {
        return store.operatorPaused()
      }
      finally {
        store.close()
      }
    },
    restorePause: async (paused) => {
      await privateDirectory(options.stateDir)
      const store = openStore({ path: join(options.stateDir, 'state.sqlite') })
      try {
        store.setOperatorPause(paused)
      }
      finally {
        store.close()
      }
    },
    lock: () => fileLock(join(options.root, 'operation.lock'), options.node),
    wait: milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds)),
  }
}

export async function manageOctorun(options: ServiceOptions, overrides: Partial<ServiceDependencies> = {}): Promise<Result<JsonValue>> {
  const rendered = renderServiceUnit(options)
  if (rendered._tag === 'Err')
    return rendered
  const deps = { ...defaults(options), ...overrides }
  const run = async (command: string, args: string[], cwd = options.repository, timeoutMs = 900000): Promise<Execution> => deps.exec(command, args, { cwd, env: options.env, timeoutMs })
  const required = async (command: string, args: string[], cwd?: string): Promise<string> => {
    const result = await run(command, args, cwd)
    if (result.code !== 0)
      throw new Error('An Octorun service operation failed.')
    return result.stdout.trim()
  }
  const unitActive = async (): Promise<boolean> => (await run('systemctl', ['--user', 'is-active', '--quiet', UNIT])).code === 0
  const unitEnabled = async (): Promise<boolean> => (await run('systemctl', ['--user', 'is-enabled', '--quiet', UNIT])).code === 0
  const stopUnit = async (): Promise<void> => {
    const stopped = await run('systemctl', ['--user', 'stop', UNIT])
    // An initial installation has no loaded unit. State ownership still must be absent.
    if (stopped.code !== 0 && (await unitActive() || await deps.control('status', {}) !== null))
      throw new Error('The Octorun unit could not stop.')
  }
  const marker = join(options.root, 'transition.json')
  const current = join(options.root, 'current')
  const releases = join(options.root, 'releases')
  const release = async (): Promise<string | null> => {
    if (!await exists(current))
      return null
    const target = await realpath(current)
    if (dirname(target) !== await realpath(releases) || !shaPattern.test(basename(target)))
      throw new Error('The installed release path is invalid.')
    return target
  }
  const readTransition = async (): Promise<Transition | null> => {
    const text = await optionalText(marker)
    if (text === null)
      return null
    const value: unknown = JSON.parse(text)
    if (!object(value) || value.version !== 1 || typeof value.next !== 'string' || !object(value.prior)
      || !(value.prior.release === null || typeof value.prior.release === 'string')
      || !(value.prior.unit === null || typeof value.prior.unit === 'string')
      || typeof value.prior.enabled !== 'boolean' || typeof value.prior.active !== 'boolean' || typeof value.prior.paused !== 'boolean') {
      throw new Error('The interrupted service operation needs inspection.')
    }
    return value as unknown as Transition
  }
  const switchCurrent = async (target: string | null): Promise<void> => {
    if (target === null) {
      if (await exists(current))
        await unlink(current)
      await syncDirectory(options.root)
      return
    }
    const link = join(options.root, `current.${crypto.randomUUID()}`)
    await symlink(target, link)
    await rename(link, current)
    await syncDirectory(options.root)
  }
  const consumeMarker = async (): Promise<void> => {
    await unlink(marker).catch((error: NodeJS.ErrnoException) => {
      // ExecStartPre can consume this marker before the manager finishes starting the unit.
      if (error.code !== 'ENOENT')
        throw error
    })
    await syncDirectory(options.root)
  }
  const restorePaused = async (transition: Transition): Promise<void> => {
    if (await unitActive() || await deps.control('status', {}) !== null)
      throw new Error('The existing controller still owns Octorun state.')
    await deps.restorePause(transition.prior.paused)
  }
  const ready = async (): Promise<void> => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const status = await deps.control('status', {})
      if (await unitActive() && status?._tag === 'Ok' && object(status.value) && status.value.ready === true)
        return
      await deps.wait(500)
    }
    throw new Error('The Octorun control socket did not become ready.')
  }
  const preflight = async (candidate: string): Promise<void> => {
    const preflight = await mkdtemp(join(options.root, 'preflight-'))
    try {
      const checked = await deps.exec(options.node, [cli(candidate), 'doctor', '--config', options.configurationPath], { cwd: candidate, env: { ...options.env, OCTORUN_KIT_STATE_DIR: preflight, OCTORUN_KIT_MODEL: options.model }, timeoutMs: 60000 })
      const diagnosis: unknown = JSON.parse(checked.stdout)
      if (checked.code !== 0 || !object(diagnosis) || diagnosis._tag !== 'Ok' || !object(diagnosis.value) || diagnosis.value.ready !== true)
        throw new Error('The prepared release did not pass diagnostics.')
    }
    finally {
      await rm(preflight, { recursive: true, force: true })
    }
  }
  let stage = 'checking configuration'
  let unlock: (() => Promise<void>) | undefined
  let transition: Transition | null = null
  let stopped = false
  try {
    if (options.action === 'status') {
      const status = await deps.control('status', {})
      return ok({ release: await release(), active: await unitActive(), enabled: await unitEnabled(), controller: status?._tag === 'Ok' ? status.value : null })
    }
    const boundary = await stateBoundary(options)
    if (boundary._tag === 'Err')
      return boundary
    // Check filesystem requirements before pausing or stopping a serving controller.
    await privateStateDirectory(options.stateDir)
    await privateDirectory(options.root)
    if (options.action === 'recover') {
      const interrupted = await readTransition()
      if (interrupted) {
        await restorePaused(interrupted)
        const serving = await realpath(options.repository)
        if (dirname(serving) === await canonicalFuture(releases) && shaPattern.test(basename(serving)))
          await switchCurrent(serving)
        await consumeMarker()
      }
      return ok({ recovered: interrupted !== null })
    }
    unlock = await deps.lock()
    const interrupted = await readTransition()
    if (interrupted && !await unitActive()) {
      await restorePaused(interrupted)
      await consumeMarker()
    }
    const oldRelease = await release()
    const oldUnit = await optionalText(options.unitPath)
    if (oldUnit !== null && !oldUnit.startsWith(unitOwner))
      return invalid('The Octorun unit was not installed by this manager. Inspect it before continuing.')
    if (oldUnit !== null && !oldUnit.includes(`\nEnvironment=${quote(`HARLAN_OCTORUN_HOME=${options.root}`)}\n`))
      return invalid('The existing unit uses another service directory. Keep its original HARLAN_OCTORUN_HOME.')
    const active = await unitActive()
    const status = await deps.control('status', {})
    if (active && (status?._tag !== 'Ok' || !object(status.value) || typeof status.value.paused !== 'boolean'))
      return invalid('The existing Octorun controller must answer before a managed transition.')
    if (!active && status !== null)
      return invalid('Another Octorun controller owns this state. Stop it before installing this unit.')
    let nextRelease = oldRelease
    if (options.action === 'install' || options.action === 'update') {
      if (!/^[a-z\d][\w/.-]{0,200}$/i.test(options.ref) || options.ref.includes('..'))
        return invalid('Use a commit or a safe merged Git reference.')
      const version = await required(options.node, ['--version'])
      if (Number(/^v(\d+)\./.exec(version)?.[1] ?? 0) < 24)
        return invalid('Octorun requires Node.js 24 or newer.')
      stage = 'fetching the merged revision'
      await required('git', ['-C', options.repository, '-c', 'credential.helper=', 'fetch', '--quiet', '--no-tags', 'https://github.com/harlan-zw/harlan-agent-kit.git', 'main:refs/remotes/origin/main'])
      const sha = await required('git', ['-C', options.repository, 'rev-parse', '--verify', `${options.ref}^{commit}`])
      if (!shaPattern.test(sha) || (await run('git', ['-C', options.repository, 'merge-base', '--is-ancestor', sha, 'origin/main'])).code !== 0)
        return invalid('The requested revision must already be merged into origin/main.')
      await privateDirectory(releases)
      nextRelease = join(releases, sha)
      if (!await exists(nextRelease)) {
        const staging = await mkdtemp(join(options.root, 'prepare-'))
        const archive = join(options.root, `archive.${crypto.randomUUID()}.tar`)
        try {
          await required('git', ['-C', options.repository, 'archive', '--format=tar', `--output=${archive}`, sha])
          await required('tar', ['-xf', archive, '-C', staging])
          stage = 'installing release dependencies'
          await required(options.pnpm, ['install', '--frozen-lockfile', '--store-dir', join(options.root, 'store')], staging)
          stage = 'building the consumer'
          await required(options.pnpm, ['--filter', 'harlan-octorun', 'build'], staging)
          stage = 'checking candidate readiness'
          await preflight(staging)
          await rename(staging, nextRelease)
        }
        finally {
          await rm(archive, { force: true })
          await rm(staging, { recursive: true, force: true })
        }
      }
      else {
        const info = await lstat(nextRelease)
        if (!info.isDirectory() || info.isSymbolicLink())
          return invalid('The prepared Octorun release must be an owned directory.')
        stage = 'checking candidate readiness'
        await preflight(nextRelease)
      }
    }
    if (!nextRelease)
      return invalid('Install an Octorun release before restarting or stopping it.')
    transition = { version: 1, next: nextRelease, prior: { release: oldRelease, unit: oldUnit, enabled: await unitEnabled(), active, paused: interrupted?.prior.paused ?? (status?._tag === 'Ok' && object(status.value) ? status.value.paused === true : await deps.readPause()) } }
    await atomicWrite(marker, JSON.stringify(transition))
    if (active) {
      stage = 'draining the serving controller'
      const drained = await deps.control('drain', {})
      if (drained?._tag !== 'Ok')
        throw new Error('The Octorun controller did not finish draining.')
    }
    stage = 'stopping the serving controller'
    await stopUnit()
    stopped = true
    await restorePaused(transition)
    if (options.action !== 'stop') {
      stage = 'activating the prepared release'
      await switchCurrent(nextRelease)
      await mkdir(dirname(options.unitPath), { recursive: true, mode: 0o700 })
      const selected = renderServiceUnit(options, nextRelease)
      if (selected._tag === 'Err')
        throw new Error(selected.error.message)
      await atomicWrite(options.unitPath, selected.value)
      await required('systemctl', ['--user', 'daemon-reload'])
      await required('systemctl', ['--user', 'enable', UNIT])
      stage = 'starting the prepared controller'
      await required('systemctl', ['--user', 'start', UNIT])
      await ready()
    }
    await consumeMarker()
    return ok({ release: nextRelease, active: options.action !== 'stop', stateDir: options.stateDir })
  }
  catch {
    if (transition && !stopped) {
      const restored = await Promise.resolve().then(async () => {
        const changed = await deps.control(transition!.prior.paused ? 'pause' : 'resume', {})
        const status = await deps.control('status', {})
        if (changed?._tag !== 'Ok' || !await unitActive() || status?._tag !== 'Ok' || !object(status.value) || status.value.paused !== transition!.prior.paused)
          return false
        await consumeMarker()
        return true
      }).catch(() => false)
      return { _tag: 'Err', error: { _tag: 'Transient', message: restored ? `Octorun failed while ${stage}. The serving controller keeps its previous admission state.` : `Octorun failed while ${stage}. Admission recovery needs inspection. Keep the private transition record.` } }
    }
    if (transition) {
      const rolledBack = await Promise.resolve().then(async () => {
        await stopUnit()
        await restorePaused(transition!)
        await switchCurrent(transition!.prior.release)
        if (transition!.prior.unit !== null)
          await atomicWrite(options.unitPath, transition!.prior.unit)
        else if (await exists(options.unitPath))
          await unlink(options.unitPath)
        await required('systemctl', ['--user', 'daemon-reload'])
        await required('systemctl', ['--user', transition!.prior.enabled ? 'enable' : 'disable', UNIT])
        if (transition!.prior.active) {
          await required('systemctl', ['--user', 'start', UNIT])
          await ready()
        }
        await consumeMarker()
      }).then(() => true).catch(() => false)
      return { _tag: 'Err', error: { _tag: 'Transient', message: rolledBack ? 'The new Octorun release failed. The previous service state was restored.' : 'The Octorun transition and rollback failed. Inspect the unit and private transition record.' } }
    }
    return { _tag: 'Err', error: { _tag: 'Transient', message: `Octorun failed while ${stage}. Inspect its paths, tools, and configuration.` } }
  }
  finally {
    await unlock?.()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ref, ...extra] = process.argv.slice(2)
  if (!['install', 'update', 'restart', 'stop', 'status', 'recover'].includes(action ?? '') || extra.length > 0 || (ref !== undefined && !['install', 'update'].includes(action!))) {
    process.stderr.write('Use install [REF], update [REF], restart, stop, or status.\n')
    process.exitCode = 1
  }
  else {
    void manageOctorun(serviceOptions(action as Action, ref ? { ref } : {})).then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`)
      process.exitCode = result._tag === 'Err' ? 1 : 0
    }).catch(() => {
      process.stderr.write('Octorun could not complete the service operation. Inspect its private directories.\n')
      process.exitCode = 1
    })
  }
}
