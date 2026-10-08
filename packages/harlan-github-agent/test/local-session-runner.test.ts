import type { SessionTurn } from '../src/session-protocol.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createHostAgentPool } from '../src/host-capacity.ts'
import { createLocalSessionRunner, localSessionSlotMaximum } from '../src/local-session-runner.ts'
import { createSessionController } from '../src/session-controller.ts'
import { SESSION_PROTOCOL } from '../src/session-protocol.ts'

const turn = { host: 'hogwild', sessionId: 'session', turnId: 'turn' } as SessionTurn
it('shares permits with maintenance and keeps a running session reserved until stopped', async () => {
  const pool = createHostAgentPool({ localMaximum: 1, desktopMaximum: 0, desktopAvailable: () => false, wait: async () => {} })
  const maintenance = pool.tryAcquireLocal('maintenance')!
  let claims = 0
  let resolveTurn!: () => void
  const pending = new Promise<void>((resolve) => {
    resolveTurn = resolve
  })
  const runner = createLocalSessionRunner({
    pool,
    maximum: () => 1,
    client: { report: async () => {}, claim: async () => {
      claims += 1
      return claims === 1 ? turn : null
    }, run: async () => pending, defer: async () => {} },
    onError: (error) => { throw error },
  })
  await runner.runNow()
  expect(claims).toBe(0)
  maintenance.release()
  await runner.runNow()
  expect(runner.activeCount()).toBe(1)
  expect(pool.tryAcquireLocal('second-maintenance')).toBeNull()
  resolveTurn()
  await Promise.resolve()
  expect(pool.tryAcquireLocal('still-reserved')).toBeNull()
  runner.release(turn.turnId)
  expect(pool.tryAcquireLocal('next-maintenance')).not.toBeNull()
  await runner.stop()
})
it('defers a claimed turn if maintenance wins admission before execution', async () => {
  const pool = createHostAgentPool({ localMaximum: 1, desktopMaximum: 0, desktopAvailable: () => false, wait: async () => {} })
  let deferred: string | null = null
  let runs = 0
  const runner = createLocalSessionRunner({
    pool,
    maximum: () => 1,
    client: {
      report: async () => {},
      claim: async () => {
        pool.tryAcquireLocal('maintenance')
        return turn
      },
      run: async () => { runs += 1 },
      defer: async (turn) => { deferred = turn.turnId },
    },
    onError: (error) => { throw error },
  })
  await runner.runNow()
  expect(deferred).toBe('turn')
  expect(runs).toBe(0)
  expect(pool.read().localActive).toBe(1)
  await runner.stop()
})
it('defers a turn when restart draining starts during its claim', async () => {
  const pool = createHostAgentPool({ localMaximum: 1, desktopMaximum: 0, desktopAvailable: () => false, wait: async () => {} })
  let draining = false
  let deferred = false
  let runs = 0
  const runner = createLocalSessionRunner({
    pool,
    maximum: () => 1,
    mayClaim: () => !draining,
    client: {
      report: async () => {},
      claim: async () => {
        draining = true
        return turn
      },
      run: async () => { runs += 1 },
      defer: async () => { deferred = true },
    },
    onError: (error) => { throw error },
  })
  await runner.runNow()
  expect(deferred).toBe(true)
  expect(runs).toBe(0)
  expect(pool.read().localActive).toBe(0)
  await runner.stop()
})
it('reserves interrupted Sessions after restart until their retired fence confirms Stop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'local-session-restart-'))
  const options = { path: join(directory, 'sessions.json'), now: () => new Date('2026-10-08T00:00:00Z') }
  try {
    const controller = createSessionController(options)
    controller.report({ host: 'hogwild', instanceId: 'previous', protocol: SESSION_PROTOCOL, projects: [{ id: 'pkg/demo', name: 'demo', path: '/home/harlan/pkg/demo', kind: 'pkg' }] })
    const session = controller.start({ host: 'hogwild', projectId: 'pkg/demo', provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high', prompt: 'Test', requestId: 'restart-test' })
    const turn = controller.claim({ host: 'hogwild', instanceId: 'previous', freeSlots: 1 })!
    const restarted = createSessionController(options)
    const pool = createHostAgentPool({ localMaximum: () => localSessionSlotMaximum(1, restarted.snapshot().sessions, () => false), desktopMaximum: 0, desktopAvailable: () => false, wait: async () => {} })
    expect(restarted.get(session.id).status).toBe('interrupted')
    expect(pool.tryAcquireLocal('maintenance-before-stop')).toBeNull()
    expect(localSessionSlotMaximum(1, restarted.snapshot().sessions, () => true)).toBe(1)
    restarted.stop(session.id)
    expect(restarted.complete({ host: 'hogwild', instanceId: 'previous', sessionId: session.id, turnId: turn.turnId, leaseToken: turn.leaseToken, outcome: 'stopped' })).toEqual({ accepted: true })
    expect(pool.tryAcquireLocal('maintenance-after-stop')).not.toBeNull()
  }
  finally { await rm(directory, { recursive: true, force: true }) }
})
it('admits a single Session with the real controller and restored-reservation capacity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'local-session-admission-'))
  const controller = createSessionController({ path: join(directory, 'sessions.json'), now: () => new Date('2026-10-08T00:00:00Z') })
  controller.report({ host: 'hogwild', instanceId: 'local', protocol: SESSION_PROTOCOL, projects: [{ id: 'pkg/demo', name: 'demo', path: '/home/harlan/pkg/demo', kind: 'pkg' }] })
  const session = controller.start({ host: 'hogwild', projectId: 'pkg/demo', provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high', prompt: 'Test', requestId: 'admission-test' })
  let runner: ReturnType<typeof createLocalSessionRunner> | undefined
  const pool = createHostAgentPool({ localMaximum: () => localSessionSlotMaximum(1, controller.snapshot().sessions, id => runner?.holds(id) ?? false), desktopMaximum: 0, desktopAvailable: () => false, wait: async () => {} })
  let executed: SessionTurn | null = null
  runner = createLocalSessionRunner({
    pool,
    maximum: () => 1,
    client: {
      report: async () => {},
      claim: async freeSlots => controller.claim({ host: 'hogwild', instanceId: 'local', freeSlots }),
      run: async (turn) => { executed = turn },
      defer: async (turn) => { controller.defer({ host: 'hogwild', instanceId: 'local', sessionId: turn.sessionId, turnId: turn.turnId, leaseToken: turn.leaseToken }) },
    },
    onError: (error) => { throw error },
  })
  try {
    await runner.runNow()
    expect(executed).toMatchObject({ host: 'hogwild', sessionId: session.id })
    expect(runner.activeCount()).toBe(1)
    expect(pool.tryAcquireLocal('maintenance')).toBeNull()
  }
  finally {
    await runner.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
