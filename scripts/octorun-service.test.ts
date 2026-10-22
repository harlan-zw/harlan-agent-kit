import type { ServiceDependencies } from './octorun-service.ts'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { openStore } from '../packages/octorun/src/control.ts'
import { manageOctorun, renderServiceUnit, serviceOptions } from './octorun-service.ts'

const execute = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'octorun-service-manager-'))
  roots.push(root)
  const repository = join(root, 'repository')
  const home = join(root, 'home')
  const legacy = join(root, 'legacy')
  await Promise.all([mkdir(repository), mkdir(home), mkdir(legacy)])
  const configurationPath = join(root, 'config.yml')
  await writeFile(configurationPath, stringify({ github: { app_id: 123, private_key_path: join(root, 'app.pem'), allowed_owners: ['harlan-zw'] }, storage: { path: join(legacy, 'state.sqlite') }, repositories: [{ github: 'harlan-zw/harlan-agent-kit', enabled: true, ownership: 'owned', checkout: repository }] }))
  await writeFile(join(repository, 'source.txt'), 'An immutable merged revision.\n')
  const git = (args: string[]) => execute('git', ['-C', repository, ...args])
  await git(['init', '--quiet'])
  await git(['add', 'source.txt'])
  await git(['-c', 'user.name=Test Agent', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'test: seed the service fixture'])
  const sha = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  await git(['update-ref', 'refs/remotes/origin/main', sha])
  const options = serviceOptions('install', { home, repository, root: join(root, 'managed'), stateDir: join(root, 'state'), configurationPath, unitPath: join(root, 'units/harlan-octorun.service'), node: process.execPath, env: {} })
  let active = false
  let enabled = false
  let paused = false
  let rejectStartup = false
  let badDoctor = false
  let rejectDrain = false
  let rejectMerged = false
  let lockHeld = false
  const calls: { command: string, args: string[], cwd: string }[] = []
  const controls: string[] = []
  const restored: boolean[] = []
  const deps: Partial<ServiceDependencies> = {
    exec: async (command, args, execution) => {
      calls.push({ command, args, cwd: execution.cwd })
      if (command === 'systemctl') {
        const action = args[1]
        if (action === 'is-active')
          return { code: active ? 0 : 3, stdout: '' }
        if (action === 'is-enabled')
          return { code: enabled ? 0 : 1, stdout: '' }
        if (action === 'stop') {
          active = false
          return { code: enabled ? 0 : 5, stdout: '' }
        }
        if (action === 'start') {
          if (rejectStartup) {
            rejectStartup = false
            return { code: 1, stdout: '' }
          }
          active = true
        }
        if (action === 'enable')
          enabled = true
        if (action === 'disable')
          enabled = false
        return { code: 0, stdout: '' }
      }
      if (command === options.node) {
        if (args[0] === '--version')
          return { code: 0, stdout: 'v24.22.0\n' }
        expect(execution.env.OCTORUN_KIT_STATE_DIR).not.toBe(options.stateDir)
        return { code: badDoctor ? 1 : 0, stdout: JSON.stringify({ _tag: 'Ok', value: { ready: !badDoctor } }) }
      }
      if (command === options.pnpm) {
        if (args.includes('build')) {
          const file = join(execution.cwd, 'packages/octorun/dist/cli.mjs')
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, 'export {};\n')
        }
        return { code: 0, stdout: '' }
      }
      if (command === 'git' && args.includes('fetch'))
        return { code: 0, stdout: '' }
      if (command === 'git' && args.includes('merge-base') && rejectMerged)
        return { code: 1, stdout: '' }
      return execute(command, args, { cwd: execution.cwd, env: { ...process.env, ...execution.env } }).then(result => ({ code: 0, stdout: result.stdout }))
    },
    control: async (command) => {
      controls.push(command)
      if (!active)
        return null
      if (command === 'drain') {
        paused = true
        if (rejectDrain)
          return { _tag: 'Err', error: { _tag: 'Transient', message: 'Fixture drain failed.' } }
        return { _tag: 'Ok', value: { drained: true } }
      }
      if (command === 'pause' || command === 'resume')
        paused = command === 'pause'
      return { _tag: 'Ok', value: { ready: true, paused } }
    },
    readPause: async () => paused,
    restorePause: async (value) => {
      expect(active).toBe(false)
      restored.push(value)
      paused = value
    },
    lock: async () => {
      if (lockHeld)
        throw new Error('Fixture manager lock is held.')
      lockHeld = true
      return async () => {
        lockHeld = false
      }
    },
    wait: async () => {},
  }
  return { root, sha, options, deps, calls, controls, restored, setPaused: (value: boolean) => {
    paused = value
  }, setBadDoctor: () => {
    badDoctor = true
  }, setRejectStartup: () => {
    rejectStartup = true
  }, setRejectDrain: () => {
    rejectDrain = true
  }, setUnmerged: () => {
    rejectMerged = true
  }, snapshot: () => ({ active, enabled, paused }) }
}

describe('managed Octorun service', () => {
  it('prepares one merged archive and starts only its compiled consumer', async () => {
    const f = await fixture()
    expect(await manageOctorun(f.options, f.deps)).toMatchObject({ _tag: 'Ok', value: { active: true } })
    const current = await realpath(join(f.options.root, 'current'))
    expect(await readFile(join(current, 'source.txt'), 'utf8')).toBe('An immutable merged revision.\n')
    expect(f.calls.find(call => call.command === f.options.pnpm && call.args.includes('install'))?.args).toContain('--frozen-lockfile')
    expect(f.calls.find(call => call.command === f.options.pnpm && call.args.includes('build'))?.args).toEqual(['--filter', 'harlan-octorun', 'build'])
    expect((await stat(f.options.root)).mode & 0o777).toBe(0o700)
    expect(f.snapshot()).toEqual({ active: true, enabled: true, paused: false })
  })

  it('keeps the previous release and manual pause when startup fails', async () => {
    const f = await fixture()
    expect((await manageOctorun(f.options, f.deps))._tag).toBe('Ok')
    const before = await realpath(join(f.options.root, 'current'))
    f.setPaused(true)
    f.setRejectStartup()
    expect(await manageOctorun({ ...f.options, action: 'restart' }, f.deps)).toMatchObject({ _tag: 'Err', error: { message: expect.stringContaining('previous service state was restored') } })
    expect(await realpath(join(f.options.root, 'current'))).toBe(before)
    expect(f.snapshot()).toEqual({ active: true, enabled: true, paused: true })
  })

  it('never stops a serving release when candidate diagnostics fail', async () => {
    const f = await fixture()
    expect((await manageOctorun(f.options, f.deps))._tag).toBe('Ok')
    f.setBadDoctor()
    const different = 'f'.repeat(40)
    const before = f.calls.filter(call => call.command === 'systemctl' && call.args[1] === 'stop').length
    const original = f.deps.exec!
    f.deps.exec = async (command, args, execution) => command === 'git' && args.includes('rev-parse') ? { code: 0, stdout: different } : original(command, command === 'git' && (args.includes('archive') || args.includes('merge-base')) ? args.map(value => value === different ? f.sha : value) : args, execution)
    expect((await manageOctorun({ ...f.options, action: 'update' }, f.deps))._tag).toBe('Err')
    expect(f.calls.filter(call => call.command === 'systemctl' && call.args[1] === 'stop')).toHaveLength(before)
    expect(f.snapshot().active).toBe(true)
  })

  it('checks candidate readiness without caller-only Claude configuration', async () => {
    const f = await fixture()
    f.options.env.CLAUDE_CONFIG_DIR = join(f.root, 'caller-only-login')
    const original = f.deps.exec!
    let diagnosed = false
    f.deps.exec = async (command, args, execution) => {
      if (command === f.options.node && args.includes('doctor')) {
        diagnosed = true
        expect(execution.env.CLAUDE_CONFIG_DIR).toBeUndefined()
        expect(execution.env.HOME).toBe(f.options.home)
        expect(execution.env.PATH).toBe(f.options.env.PATH)
      }
      return original(command, args, execution)
    }
    expect((await manageOctorun(f.options, f.deps))._tag).toBe('Ok')
    expect(diagnosed).toBe(true)
  })

  it('rejects an unmerged revision before building or stopping anything', async () => {
    const f = await fixture()
    f.setUnmerged()
    expect(await manageOctorun(f.options, f.deps)).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration', message: expect.stringContaining('merged') } })
    expect(f.calls.some(call => call.command === f.options.pnpm || (call.command === 'systemctl' && call.args[1] === 'stop'))).toBe(false)
  })

  it('recovers a paused interrupted transition before the controller starts', async () => {
    const f = await fixture()
    await mkdir(f.options.root)
    await writeFile(join(f.options.root, 'transition.json'), JSON.stringify({ version: 1, next: join(f.options.root, 'releases', f.sha), prior: { release: null, unit: null, enabled: false, active: false, paused: true } }), { mode: 0o600 })
    expect(await manageOctorun({ ...f.options, action: 'recover' }, f.deps)).toEqual({ _tag: 'Ok', value: { recovered: true } })
    expect(f.restored).toEqual([true])
    expect(f.calls.some(call => call.command === 'systemctl' && ['start', 'stop', 'enable'].includes(call.args[1]!))).toBe(false)
    f.setPaused(false)
    expect(await manageOctorun({ ...f.options, action: 'recover' }, f.deps)).toEqual({ _tag: 'Ok', value: { recovered: false } })
    expect(f.snapshot().paused).toBe(false)
  })

  it('rejects production state that overlaps the legacy Service', async () => {
    const f = await fixture()
    expect(await manageOctorun({ ...f.options, stateDir: join(f.root, 'legacy') }, f.deps)).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
    expect(f.restored).toEqual([])
    expect(f.calls).toEqual([])
  })

  it('leaves the serving controller running when drain fails', async () => {
    const f = await fixture()
    expect((await manageOctorun(f.options, f.deps))._tag).toBe('Ok')
    f.setRejectDrain()
    const before = f.calls.filter(call => call.command === 'systemctl' && call.args[1] === 'stop').length
    expect((await manageOctorun({ ...f.options, action: 'restart' }, f.deps))._tag).toBe('Err')
    expect(f.calls.filter(call => call.command === 'systemctl' && call.args[1] === 'stop')).toHaveLength(before)
    expect(f.snapshot().active).toBe(true)
    expect(f.snapshot().paused).toBe(false)
  })

  it('rejects state symlinks before draining the serving controller', async () => {
    const f = await fixture()
    expect((await manageOctorun(f.options, f.deps))._tag).toBe('Ok')
    await mkdir(f.options.stateDir, { recursive: true })
    const alias = join(f.root, 'state-alias')
    await symlink(f.options.stateDir, alias)
    const before = f.calls.length
    expect((await manageOctorun({ ...f.options, action: 'restart', stateDir: alias }, f.deps))._tag).toBe('Err')
    expect(f.calls.slice(before).some(call => call.command === 'systemctl' && call.args[1] === 'stop')).toBe(false)
    expect(f.snapshot()).toEqual({ active: true, enabled: true, paused: false })
  })

  it('rejects a different managed root before draining the existing unit', async () => {
    const f = await fixture()
    expect((await manageOctorun(f.options, f.deps))._tag).toBe('Ok')
    const before = f.controls.length
    expect((await manageOctorun({ ...f.options, root: join(f.root, 'other-managed') }, f.deps))._tag).toBe('Err')
    expect(f.controls.slice(before)).not.toContain('drain')
    expect(f.snapshot()).toEqual({ active: true, enabled: true, paused: false })
  })

  it('checks state file types before stopping the serving controller', async () => {
    const f = await fixture()
    expect((await manageOctorun(f.options, f.deps))._tag).toBe('Ok')
    await mkdir(join(f.options.stateDir, 'state.sqlite'))
    const before = f.calls.length
    expect((await manageOctorun({ ...f.options, action: 'restart' }, f.deps))._tag).toBe('Err')
    expect(f.calls.slice(before).some(call => call.command === 'systemctl' && call.args[1] === 'stop')).toBe(false)
    expect(f.snapshot()).toEqual({ active: true, enabled: true, paused: false })
  })

  it('prepares the actual unit destination before draining a serving controller', async () => {
    const f = await fixture()
    expect((await manageOctorun(f.options, f.deps))._tag).toBe('Ok')
    await chmod(dirname(f.options.unitPath), 0o500)
    const before = f.calls.length
    try {
      expect((await manageOctorun({ ...f.options, action: 'restart' }, f.deps))._tag).toBe('Err')
      expect(f.calls.slice(before).some(call => call.command === 'systemctl' && call.args[1] === 'stop')).toBe(false)
      expect(f.snapshot()).toEqual({ active: true, enabled: true, paused: false })
    }
    finally {
      await chmod(dirname(f.options.unitPath), 0o700)
    }
  })

  it('preserves manual pause when a stopped unit starts again', async () => {
    const f = await fixture()
    expect((await manageOctorun(f.options, f.deps))._tag).toBe('Ok')
    f.setPaused(true)
    expect((await manageOctorun({ ...f.options, action: 'stop' }, f.deps))._tag).toBe('Ok')
    expect((await manageOctorun({ ...f.options, action: 'restart' }, f.deps))._tag).toBe('Ok')
    expect(f.snapshot()).toEqual({ active: true, enabled: true, paused: true })
  })

  it('aligns the selected release with the immutable unit that recovers once', async () => {
    const f = await fixture()
    expect((await manageOctorun(f.options, f.deps))._tag).toBe('Ok')
    const previous = await realpath(join(f.options.root, 'current'))
    expect((await manageOctorun({ ...f.options, action: 'stop' }, f.deps))._tag).toBe('Ok')
    const next = join(f.options.root, 'releases', 'a'.repeat(40))
    await mkdir(next)
    await rm(join(f.options.root, 'current'))
    await symlink(next, join(f.options.root, 'current'))
    await writeFile(join(f.options.root, 'transition.json'), JSON.stringify({ version: 1, next, prior: { release: previous, unit: null, enabled: true, active: true, paused: false } }), { mode: 0o600 })
    expect((await manageOctorun({ ...f.options, action: 'recover', repository: previous }, f.deps))._tag).toBe('Ok')
    expect(await realpath(join(f.options.root, 'current'))).toBe(previous)
    f.setPaused(true)
    expect(await manageOctorun({ ...f.options, action: 'recover', repository: previous }, f.deps)).toEqual({ _tag: 'Ok', value: { recovered: false } })
    expect(f.snapshot().paused).toBe(true)
  })

  it('refuses offline pause recovery while a controller owns the state', async () => {
    const f = await fixture()
    expect((await manageOctorun(f.options, f.deps))._tag).toBe('Ok')
    await writeFile(join(f.options.root, 'transition.json'), JSON.stringify({ version: 1, next: join(f.options.root, 'releases', f.sha), prior: { release: null, unit: null, enabled: false, active: false, paused: true } }), { mode: 0o600 })
    const before = f.restored.length
    expect((await manageOctorun({ ...f.options, action: 'recover' }, f.deps))._tag).toBe('Err')
    expect(f.restored).toHaveLength(before)
    expect(f.snapshot().active).toBe(true)
  })

  it.each(['repository', 'legacy'] as const)('rejects a managed release root inside the %s directory', async (directory) => {
    const f = await fixture()
    const root = join(directory === 'repository' ? f.options.repository : join(f.root, 'legacy'), 'deployment')
    expect(await manageOctorun({ ...f.options, root }, f.deps)).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
    expect(f.calls).toEqual([])
  })

  it('rejects a release root hidden below a symlink into the primary checkout', async () => {
    const f = await fixture()
    const alias = join(f.root, 'checkout-alias')
    await symlink(f.options.repository, alias)
    expect(await manageOctorun({ ...f.options, root: join(alias, 'deployment') }, f.deps)).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
    expect(f.calls).toEqual([])
  })

  it.each(['repository', 'unitPath'] as const)('rejects a relative %s before any service operation', async (field) => {
    const f = await fixture()
    expect(await manageOctorun({ ...f.options, [field]: 'relative/path' }, f.deps)).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
    expect(f.calls).toEqual([])
  })

  it('cannot restore pause while another controller holds the SQLite owner lock', async () => {
    const f = await fixture()
    await mkdir(f.options.root)
    await mkdir(f.options.stateDir)
    const owner = openStore({ path: join(f.options.stateDir, 'state.sqlite') })
    owner.setOperatorPause(true)
    await writeFile(join(f.options.root, 'transition.json'), JSON.stringify({ version: 1, next: join(f.options.root, 'releases', f.sha), prior: { release: null, unit: null, enabled: false, active: false, paused: false } }), { mode: 0o600 })
    const deps = { ...f.deps }
    delete deps.restorePause
    try {
      expect((await manageOctorun({ ...f.options, action: 'recover' }, deps))._tag).toBe('Err')
      expect(owner.operatorPaused()).toBe(true)
    }
    finally {
      owner.close()
    }
  })

  it('serializes concurrent managers with the real operating system lock', async () => {
    const f = await fixture()
    const deps = { ...f.deps }
    delete deps.lock
    let releaseBuild!: () => void
    let buildStarted!: () => void
    const started = new Promise<void>((complete) => {
      buildStarted = complete
    })
    const gate = new Promise<void>((complete) => {
      releaseBuild = complete
    })
    const original = deps.exec!
    deps.exec = async (command, args, options) => {
      if (command === f.options.pnpm && args.includes('build')) {
        buildStarted()
        await gate
      }
      return original(command, args, options)
    }
    const first = manageOctorun(f.options, deps)
    await started
    expect((await manageOctorun(f.options, deps))._tag).toBe('Err')
    releaseBuild()
    expect((await first)._tag).toBe('Ok')
  })

  it('renders a valid systemd unit with literal path characters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'octorun-unit-parser-'))
    roots.push(root)
    const options = serviceOptions('install', { home: '/home/test $HOME %n', repository: '/repository', env: {} })
    const unit = renderServiceUnit(options)
    if (unit._tag === 'Err')
      throw new Error(unit.error.message)
    const path = join(root, 'harlan-octorun.service')
    await writeFile(path, unit.value)
    await execute('systemd-analyze', ['verify', path])
    expect(renderServiceUnit({ ...options, stateDir: '/state\nExecStart=unsafe' })).toMatchObject({ _tag: 'Err' })
  })
})
