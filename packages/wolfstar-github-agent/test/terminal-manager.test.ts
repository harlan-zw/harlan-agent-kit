import type { TerminalAdmission, TerminalAdmissionResult } from '../src/terminal-admission.ts'
import type { TerminalHelperConfig } from '../src/terminal-manager.ts'
import type { TerminalProvider } from '../src/terminal-protocol.ts'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { writeTerminalJson } from '../src/terminal-storage.ts'
import { createTerminalManager } from '../src/terminal.ts'

const managers: Awaited<ReturnType<typeof createTerminalManager>>[] = []
const directories: string[] = []
it('reports authoritative aggregate host memory without private broker diagnostics', async () => {
  const fixture_ = await fixture()
  const manager = await fixture_.manager()
  expect(await manager.capacity()).toMatchObject({
    _tag: 'Available',
    memoryGiB: 16,
    reservedGiB: 0,
    sessionMemoryGiB: 8,
    manualPolicy: { _tag: 'Enabled', memoryGiB: 32 },
    regular: { _tag: 'Allowed' },
  })
})
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true })
})
async function fixture(providerArguments: Partial<Record<TerminalProvider, string[]>> = {}) {
  const root = join(homedir(), 'scratch')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'terminal-manager-test-'))
  directories.push(directory)
  let running = false
  let leader = true
  let ready = true
  let releaseResult: TerminalAdmissionResult = { _tag: 'Empty' }
  let refused = false
  let manualRefused = false
  let manualUnavailable = false
  let reserveCount = 0
  let raceRelease = false
  let emptyChecks = 0
  let released = false
  let missingAfterStop = false
  let receiptResult: TerminalAdmissionResult = { _tag: 'Conflict' }
  let receipt: Parameters<TerminalAdmission['completedReceipt']>[0] | null = null
  const starts: string[] = []
  const arguments_: string[][] = []
  const releases: string[] = []
  const scope = {
    unit: '',
    invocationId: 'owned-invocation',
    controlGroup: '/owned/cgroup',
  }
  const options: Parameters<typeof createTerminalManager>[0] = {
    directory,
    bootId: 'boot',
    hostLabel: 'Fixture',
    controller: false,
    projects: [{ id: 'project', name: 'Project', path: directory }],
    providers: {
      codex: { executable: '/bin/fixture', argv: providerArguments.codex ?? [], available: true },
      claude: { executable: '/bin/fixture', argv: providerArguments.claude ?? [], available: true },
      opencode: { executable: '/bin/fixture', argv: providerArguments.opencode ?? [], available: true },
    },
    artifact: {
      entry: '/artifact',
      digest: 'digest',
      wasm: '/wasm',
      wasmDigest: 'wasm',
      claimScript: '/claim',
      claimDigest: 'claim-digest',
    },
    admissionCli: '/capacity',
    claimScript: '/claim',
    memoryGiB: 1,
    admission: {
      completedReceipt: async (value) =>
        receipt &&
        value.requestId === receipt.requestId &&
        value.fingerprint === receipt.fingerprint &&
        value.key === receipt.key &&
        value.reservationId === receipt.reservationId &&
        value.unit === receipt.unit
          ? receiptResult
          : { _tag: 'Conflict' },
      status: async () => ({ _tag: 'Unavailable', reason: 'Fixture' }),
      capacity: async () => ({
        _tag: 'Capacity',
        memoryGiB: 16,
        reservedGiB: 0,
        agentSlots: 2,
        agentSlotsUsed: 0,
        maintenanceReserve: 1,
        forcedGiB: 0,
        sessionMemoryGiB: 8,
        memory: { _tag: 'Physical', totalGiB: 64, availableGiB: 48 },
        manualPolicy: { _tag: 'Enabled', memoryGiB: 32, agentSlotsMax: 4, physicalReserveGiB: 4 },
        regular: refused ? { _tag: 'AtCapacity', reason: 'Slots', memoryGiB: 16, reservedGiB: 0 } : { _tag: 'Allowed' },
        manual: { _tag: 'Allowed' },
      }),
      reserve: async (value) => {
        reserveCount++
        receipt = {
          requestId: value.requestId,
          fingerprint: value.fingerprint,
          key: value.key,
          reservationId: 'reservation',
          unit: value.unit,
        }
        return value.admission === 'ManualOverride'
          ? manualUnavailable
            ? { _tag: 'Unavailable', reason: 'Physical memory cannot be verified' }
            : manualRefused
              ? { _tag: 'AtCapacity', reason: 'MemoryPressure' }
              : {
                  _tag: 'Admitted',
                  reservationId: 'reservation',
                  disposition: 'Created',
                  unit: value.unit,
                  hostId: 'host',
                  bootId: 'boot',
                }
          : refused
            ? { _tag: 'AtCapacity', reason: 'Slots' }
            : {
                _tag: 'Admitted',
                reservationId: 'reservation',
                disposition: 'Created',
                unit: value.unit,
                hostId: 'host',
                bootId: 'boot',
              }
      },
      bind: async () => ({
        _tag: 'Bound',
        reservationId: 'reservation',
        scope,
      }),
      reconcile: async () => {
        if (running) return { _tag: 'Alive', reservationId: 'reservation', scope }
        if (missingAfterStop) return { _tag: 'Missing' }
        if (raceRelease && emptyChecks++ > 0) await delay(15)
        return released && raceRelease ? { _tag: 'Missing' } : { _tag: 'Empty' }
      },
      release: async () => {
        released = releaseResult._tag === 'Empty'
        return releaseResult
      },
      cancel: async () => ({ _tag: 'Conflict' }),
    },
    processHost: {
      inspect: async () => ({
        loadState: 'loaded',
        activeState: running ? 'active' : 'inactive',
        invocationId: scope.invocationId,
        controlGroup: scope.controlGroup,
        mainPid: leader ? 123 : 0,
      }),
      start: async (value) => {
        scope.unit = value.unit
        starts.push(value.unit)
        const config = JSON.parse(await readFile(value.config, 'utf8')) as TerminalHelperConfig
        arguments_.push(config.argv)
        await writeTerminalJson(join(directory, 'sessions', config.intent.session.id, 'prepared.json'), {
          generation: config.intent.session.generation,
          invocationId: scope.invocationId,
          worktree: directory,
        })
        running = true
      },
      stop: async () => {
        running = false
        return 'Stopped'
      },
    },
    recoverWorktree: async () => directory,
    releaseWorktree: async (id) => {
      releases.push(id)
    },
    renewWorktree: async () => {},
    ready: async () => ready,
    now: () => new Date('2026-10-12T00:00:00Z'),
    log: () => {},
  }
  async function manager() {
    const result = await createTerminalManager(options)
    managers.push(result)
    return result
  }
  return {
    manager,
    admission: options.admission,
    deferStop() {
      const gate = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      const original = options.processHost.stop
      options.processHost.stop = async (...args) => {
        entered.resolve()
        await gate.promise
        return original(...args)
      }
      return { entered: entered.promise, release: gate.resolve }
    },
    starts,
    arguments_,
    releases,
    sweepOnStop(result: TerminalAdmissionResult) {
      missingAfterStop = true
      receiptResult = result
    },
    empty: () => {
      running = false
    },
    helperLost: () => {
      leader = false
      ready = false
    },
    refuse: () => {
      refused = true
    },
    allow: () => {
      refused = false
    },
    refuseManual: () => {
      manualRefused = true
    },
    unavailableManual: () => {
      manualUnavailable = true
    },
    reserveCount: () => reserveCount,
    raceRelease: () => {
      running = false
      raceRelease = true
    },
    refuseRelease: () => {
      releaseResult = { _tag: 'Unknown', reason: 'Scope changed' }
    },
  }
}
const launch = {
  requestId: 'request',
  projectId: 'project',
  provider: 'codex' as const,
}
describe('durable terminal launch and ownership', () => {
  it('fences ambiguous manual outcomes across restart without replacing the admission request', async () => {
    const f = await fixture()
    const manager = await f.manager()
    f.refuse()
    const queued = await manager.launch(launch)
    if (queued._tag !== 'Ok') throw new Error('Fixture queue failed')
    f.unavailableManual()
    const requests: Parameters<TerminalAdmission['reserve']>[0][] = []
    const originalReserve = f.admission.reserve
    let responseLost = true
    f.admission.reserve = async (value) => {
      await originalReserve(value)
      requests.push(structuredClone(value))
      return responseLost
        ? { _tag: 'Unavailable', reason: 'Connection ended after committed admission' }
        : {
            _tag: 'Admitted',
            disposition: 'Existing',
            reservationId: 'reservation',
            unit: value.unit,
            hostId: 'host',
            bootId: 'boot',
          }
    }
    f.admission.reconcile = async () => ({ _tag: 'Unknown', reason: 'Committed Starting charge has no verified scope' })
    const cancellations: Parameters<TerminalAdmission['cancel']>[0][] = []
    f.admission.cancel = async (value) => {
      cancellations.push(value)
      return { _tag: 'Unknown' }
    }
    expect(await manager.forceQueued(queued.value.id, 'unverified-memory')).toEqual({
      _tag: 'Err',
      reason: 'DeliveryUnknown',
    })
    expect(manager.intent(queued.value.id)?.admission).toEqual({
      _tag: 'ManualOverride',
      requestId: 'manual:unverified-memory',
    })
    f.allow()
    await manager.retryQueued()
    expect(f.starts).toHaveLength(0)
    expect(await manager.stop(queued.value.id)).toEqual({ _tag: 'Err', reason: 'DeliveryUnknown' })
    expect(cancellations).toEqual([])
    await manager.close()
    const recovered = await f.manager()
    expect(await recovered.forceQueued(queued.value.id, 'new-browser-attempt')).toEqual({
      _tag: 'Err',
      reason: 'DeliveryUnknown',
    })
    await recovered.retryQueued()
    expect(f.reserveCount()).toBe(3)
    responseLost = false
    expect(await recovered.forceQueued(queued.value.id, 'another-browser-attempt')).toMatchObject({
      _tag: 'Ok',
      value: { id: queued.value.id, state: 'Unknown' },
    })
    expect(requests).toHaveLength(3)
    expect(
      requests.every((value) => value.requestId === 'manual:unverified-memory' && value.admission === 'ManualOverride'),
    ).toBe(true)
    expect(f.starts).toHaveLength(0)
    expect(await recovered.stop(queued.value.id)).toEqual({ _tag: 'Err', reason: 'OwnershipUnknown' })
    expect(cancellations).toEqual([{ key: `terminal:${queued.value.id}`, reservationId: 'reservation' }])
  })
  it('releases an adopted Worktree after another client sweeps the proven-empty charge', async () => {
    const f = await fixture()
    const original = await f.manager()
    const launched = await original.launch(launch)
    expect(launched._tag).toBe('Ok')
    if (launched._tag !== 'Ok') throw new Error('Fixture launch failed')
    await original.close()
    const adopted = await f.manager()
    f.sweepOnStop({ _tag: 'Completed' })
    const stopped = await adopted.stop(launched.value.id)
    expect(stopped._tag === 'Ok' && stopped.value.state).toBe('Exited')
    expect(f.releases).toEqual([launched.value.id])
    expect(f.reserveCount()).toBe(1)
    expect(f.starts).toHaveLength(1)
  })
  it.each(['Missing', 'Conflict', 'Unknown'] as const)(
    'retains the Worktree when a swept charge has a %s receipt',
    async (_tag) => {
      const f = await fixture()
      const manager = await f.manager()
      const launched = await manager.launch(launch)
      if (launched._tag !== 'Ok') throw new Error('Fixture launch failed')
      f.sweepOnStop({ _tag })
      const stopped = await manager.stop(launched.value.id)
      expect(stopped._tag === 'Ok' && stopped.value.state).toBe('Unknown')
      expect(f.releases).toEqual([])
      expect(f.reserveCount()).toBe(1)
    },
  )
  it.each(['codex', 'claude', 'opencode'] as const)(
    'launches %s with only its configured provider arguments',
    async (provider) => {
      const arguments_ =
        provider === 'codex' ? ['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write'] : []
      const fixture_ = await fixture({ [provider]: arguments_ })
      const manager = await fixture_.manager()
      await manager.launch({ ...launch, provider })
      expect(fixture_.arguments_).toEqual([arguments_])
    },
  )
  it('drains accepted Stop writes and refuses operations after close', async () => {
    const fixture_ = await fixture()
    const manager = await fixture_.manager()
    const created = await manager.launch(launch)
    if (created._tag !== 'Ok') throw new Error('Fixture launch failed')
    const gate = fixture_.deferStop()
    const stopping = manager.stop(created.value.id)
    await gate.entered
    let closed = false
    const closing = Promise.resolve(manager.close()).then(() => {
      closed = true
    })
    await delay(10)
    expect(closed).toBe(false)
    expect(await manager.launch({ ...launch, requestId: 'after-close' })).toEqual({
      _tag: 'Err',
      reason: 'OwnershipUnknown',
    })
    expect(await manager.stop(created.value.id)).toEqual({ _tag: 'Err', reason: 'OwnershipUnknown' })
    gate.release()
    await stopping
    await closing
    expect((await manager.sessions())[0]?.state).toBe('Exited')
    expect(fixture_.starts).toHaveLength(1)
  })
  it('keeps released ownership final when concurrent discovery observes Missing', async () => {
    const fixture_ = await fixture()
    const manager = await fixture_.manager()
    await manager.launch(launch)
    fixture_.raceRelease()
    await Promise.all([manager.sessions(), manager.sessions()])
    expect((await manager.sessions())[0]?.state).toBe('Exited')
    expect(fixture_.releases).toHaveLength(1)
  })
  it('keeps a refused session queued across restart and starts it once when memory returns', async () => {
    const fixture_ = await fixture()
    fixture_.refuse()
    const manager = await fixture_.manager()
    const queued = await manager.launch(launch)
    expect(queued._tag === 'Ok' && queued.value.state).toBe('Queued')
    expect(fixture_.starts).toEqual([])
    await manager.close()
    const restarted = await fixture_.manager()
    expect((await restarted.sessions())[0]?.state).toBe('Queued')
    fixture_.allow()
    await Promise.all([restarted.retryQueued(), restarted.retryQueued()])
    expect((await restarted.sessions())[0]?.state).toBe('Running')
    const replay = await restarted.launch(launch)
    expect(replay._tag === 'Ok' && replay.value.state).toBe('Running')
    expect(fixture_.reserveCount()).toBe(2)
    expect(fixture_.starts).toHaveLength(1)
  })
  it('cancels queued work durably without preparing or starting a provider', async () => {
    const f = await fixture()
    f.refuse()
    const manager = await f.manager()
    const queued = await manager.launch(launch)
    if (queued._tag !== 'Ok') throw new Error('Fixture did not queue')
    expect((await manager.stop(queued.value.id))._tag).toBe('Ok')
    await manager.close()
    const restarted = await f.manager()
    f.allow()
    await restarted.retryQueued()
    const replay = await restarted.launch(launch)
    expect(replay._tag === 'Ok' && replay.value.state).toBe('Cancelled')
    expect(f.reserveCount()).toBe(1)
    expect(f.starts).toEqual([])
  })
  it('upgrades the same queued session once when concurrent Force requests repeat', async () => {
    const f = await fixture()
    f.refuse()
    const manager = await f.manager()
    const queued = await manager.launch(launch)
    if (queued._tag !== 'Ok') throw new Error('Fixture did not queue')
    const results = await Promise.all([
      manager.forceQueued(queued.value.id, 'force'),
      manager.forceQueued(queued.value.id, 'force'),
    ])
    expect(results.map((value) => value._tag === 'Ok' && value.value.id)).toEqual([queued.value.id, queued.value.id])
    expect(f.starts).toHaveLength(1)
    expect(f.reserveCount()).toBe(2)
    f.allow()
    await manager.retryQueued()
    expect(f.starts).toHaveLength(1)
  })
  it('keeps refused Force eligible for Regular retry and fences the refused attempt across restart', async () => {
    const f = await fixture()
    f.refuse()
    f.refuseManual()
    const manager = await f.manager()
    const queued = await manager.launch(launch)
    if (queued._tag !== 'Ok') throw new Error('Fixture did not queue')
    const forced = await manager.forceQueued(queued.value.id, 'force')
    expect(forced._tag === 'Ok' && forced.value.state).toBe('Queued')
    await manager.close()
    const restarted = await f.manager()
    await restarted.forceQueued(queued.value.id, 'force')
    expect(f.reserveCount()).toBe(2)
    f.allow()
    await restarted.retryQueued()
    expect(f.reserveCount()).toBe(3)
    expect(f.starts).toHaveLength(1)
  })
  it('preserves FIFO and admits only one queued session per retry', async () => {
    const f = await fixture()
    f.refuse()
    const manager = await f.manager()
    const first = await manager.launch(launch)
    await manager.launch({ ...launch, requestId: 'second' })
    f.allow()
    await manager.launch({ ...launch, requestId: 'third' })
    expect(f.reserveCount()).toBe(1)
    await Promise.all([manager.retryQueued(), manager.retryQueued()])
    expect(f.starts).toEqual([first._tag === 'Ok' ? `wolfstar-terminal-${first.value.id}.service` : 'missing'])
    await manager.retryQueued()
    expect(f.starts).toHaveLength(2)
  })
  it('serializes Force against automatic Regular admission without duplicating paid work', async () => {
    const f = await fixture()
    f.refuse()
    const manager = await f.manager()
    const queued = await manager.launch(launch)
    if (queued._tag !== 'Ok') throw new Error('Fixture did not queue')
    f.allow()
    await Promise.all([manager.retryQueued(), manager.forceQueued(queued.value.id, 'force')])
    expect(f.starts).toHaveLength(1)
    expect(f.reserveCount()).toBe(2)
  })
  it.each(['codex', 'claude', 'opencode'] as const)(
    'delivers the initial %s prompt as one provider argument',
    async (provider) => {
      const f = await fixture()
      const manager = await f.manager()
      const initialPrompt = '--help; $(touch secret)\nKeep this exact text.'
      await manager.launch({ ...launch, provider, initialPrompt })
      expect(f.arguments_[0]).toEqual(provider === 'opencode' ? [`--prompt=${initialPrompt}`] : ['--', initialPrompt])
      expect(await manager.launch({ ...launch, provider, initialPrompt: 'Different work' })).toEqual({
        _tag: 'Err',
        reason: 'LaunchConflict',
      })
      expect(f.starts).toHaveLength(1)
    },
  )
  it('coalesces accepted launch requests and adopts the same session after an API restart', async () => {
    const fixture_ = await fixture()
    const first = await fixture_.manager()
    const [a, b] = await Promise.all([first.launch(launch), first.launch(launch)])
    expect(a).toEqual(b)
    expect(a._tag).toBe('Ok')
    first.close()
    const second = await fixture_.manager()
    expect(await second.launch(launch)).toEqual(a)
    expect(fixture_.starts).toHaveLength(1)
  })
  it('rejects reusing an accepted request for a different provider', async () => {
    const fixture_ = await fixture()
    const manager = await fixture_.manager()
    await manager.launch(launch)
    expect(await manager.launch({ ...launch, provider: 'claude' })).toEqual({
      _tag: 'Err',
      reason: 'LaunchConflict',
    })
    expect(fixture_.starts).toHaveLength(1)
  })
  it('retains the Worktree claim when release cannot prove the scope empty', async () => {
    const fixture_ = await fixture()
    const manager = await fixture_.manager()
    await manager.launch(launch)
    fixture_.empty()
    fixture_.refuseRelease()
    expect((await manager.sessions())[0]?.state).toBe('Unknown')
    expect(fixture_.releases).toEqual([])
  })
  it('retains ownership after helper loss while the process scope remains alive', async () => {
    const fixture_ = await fixture()
    const manager = await fixture_.manager()
    const created = await manager.launch(launch)
    fixture_.helperLost()
    expect((await manager.sessions())[0]?.state).toBe('Unknown')
    expect(await manager.launch(launch)).toMatchObject({
      _tag: 'Ok',
      value: { state: 'Unknown' },
    })
    expect(fixture_.starts).toHaveLength(1)
    expect(fixture_.releases).toEqual([])
    expect(created._tag).toBe('Ok')
  })
  it('releases the Worktree only after a verified whole-scope Stop', async () => {
    const fixture_ = await fixture()
    const manager = await fixture_.manager()
    const created = await manager.launch(launch)
    if (created._tag !== 'Ok') throw new Error('Fixture launch failed')
    expect(await manager.stop(created.value.id)).toMatchObject({
      _tag: 'Ok',
      value: { state: 'Exited' },
    })
    expect(fixture_.releases).toEqual([created.value.id])
  })
})
