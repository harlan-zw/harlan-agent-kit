import type { TerminalAdmissionResult } from '../src/terminal-admission.ts'
import type { TerminalHelperConfig } from '../src/terminal-manager.ts'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeTerminalJson } from '../src/terminal-storage.ts'
import { createTerminalManager } from '../src/terminal.ts'

const managers: Awaited<ReturnType<typeof createTerminalManager>>[] = []
const directories: string[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true })
})
async function fixture() {
  const root = join(homedir(), 'scratch')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'terminal-manager-test-'))
  directories.push(directory)
  let running = false
  let leader = true
  let ready = true
  let releaseResult: TerminalAdmissionResult = { _tag: 'Empty' }
  let refused = false
  let reserveCount = 0
  const starts: string[] = []
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
      codex: { executable: '/bin/fixture', argv: [], available: true },
      claude: { executable: '/bin/fixture', argv: [], available: true },
      opencode: { executable: '/bin/fixture', argv: [], available: true },
    },
    artifact: {
      entry: '/artifact',
      digest: 'digest',
      wasm: '/wasm',
      wasmDigest: 'wasm',
    },
    admissionCli: '/capacity',
    claimScript: '/claim',
    memoryGiB: 1,
    admission: {
      status: async () => ({ _tag: 'Unavailable', reason: 'Fixture' }),
      reserve: async (value) => {
        reserveCount++
        return refused
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
      reconcile: async () =>
        running
          ? { _tag: 'Alive', reservationId: 'reservation', scope }
          : { _tag: 'Empty' },
      release: async () => releaseResult,
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
        const config = JSON.parse(
          await readFile(value.config, 'utf8'),
        ) as TerminalHelperConfig
        await writeTerminalJson(
          join(
            directory,
            'sessions',
            config.intent.session.id,
            'prepared.json',
          ),
          {
            generation: config.intent.session.generation,
            invocationId: scope.invocationId,
            worktree: directory,
          },
        )
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
    starts,
    releases,
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
    reserveCount: () => reserveCount,
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
  it('replays definitive capacity refusal without creating a dead session', async () => {
    const fixture_ = await fixture()
    fixture_.refuse()
    const manager = await fixture_.manager()
    expect(await manager.launch(launch)).toEqual({
      _tag: 'Err',
      reason: 'CapacityRefused',
    })
    fixture_.allow()
    expect(await manager.launch(launch)).toEqual({
      _tag: 'Err',
      reason: 'CapacityRefused',
    })
    expect(fixture_.reserveCount()).toBe(1)
    expect(fixture_.starts).toEqual([])
  })
  it('coalesces accepted launch requests and adopts the same session after an API restart', async () => {
    const fixture_ = await fixture()
    const first = await fixture_.manager()
    const [a, b] = await Promise.all([
      first.launch(launch),
      first.launch(launch),
    ])
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
    if (created._tag !== 'Ok')
      throw new Error('Fixture launch failed')
    expect(await manager.stop(created.value.id)).toMatchObject({
      _tag: 'Ok',
      value: { state: 'Exited' },
    })
    expect(fixture_.releases).toEqual([created.value.id])
  })
})
