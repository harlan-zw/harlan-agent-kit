import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentProviderFailureReason } from '../src/agent-provider.ts'
import { openJournalStore } from '../src/store.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []
const temporaryDirectories: string[] = []

afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { force: true, recursive: true }))
})

function store() {
  const journal = openJournalStore(':memory:')
  stores.push(journal)
  return journal
}

const circuit = {
  provider: 'opencode' as const,
  credential: 'opencode-go',
  model: 'zai-coding-plan/glm-5.3-flash',
  failureClass: 'network' as const,
}

it('holds an exhausted model after one failure without blocking OpenCode Go', () => {
  const journal = store()
  journal.recordProviderFailure({
    ...circuit,
    failureClass: 'usage_limit',
    detail: 'Weekly/Monthly Limit Exhausted',
    at: '2026-10-12T01:00:00.000Z',
  })
  expect(journal.providerCanStart({ ...circuit, at: '2026-10-12T01:01:00.000Z' })).toBe(false)
  expect(
    journal.providerCanStart({ ...circuit, model: 'zai-coding-plan/glm-5.3', at: '2026-10-12T01:01:00.000Z' }),
  ).toBe(false)
  expect(
    journal.providerCanStart({ ...circuit, model: 'opencode-go/glm-5.3-flash', at: '2026-10-12T01:01:00.000Z' }),
  ).toBe(true)
  const model = 'zai-coding-plan/glm-5.3'
  const canary = journal.reserveProviderStart({
    ...circuit,
    model,
    workerId: 'quota-canary',
    at: '2026-10-12T06:01:00.000Z',
    leaseMilliseconds: 60_000,
  })
  if (canary._tag !== 'Allowed' || canary.canary === null) throw new Error('Expected a shared plan canary.')
  expect(
    journal.recordProviderSuccess({
      ...circuit,
      model,
      workerId: canary.canary.workerId,
      canaryCircuitId: canary.canary.circuitId,
      canaryFence: canary.canary.fence,
      at: '2026-10-12T06:01:10.000Z',
    }),
  ).toBe(1)
  expect(journal.providerCanStart({ ...circuit, at: '2026-10-12T06:02:00.000Z' })).toBe(true)
  journal.recordProviderFailure({
    ...circuit,
    failureClass: 'usage_limit',
    detail: 'Weekly limit exhausted.',
    at: '2026-10-12T06:03:00.000Z',
  })
  expect(journal.providerCanStart({ ...circuit, at: '2026-10-12T06:04:00.000Z' })).toBe(false)
})

describe('persistent Agent provider circuits', () => {
  it('releases a cancelled canary without changing health and rejects its stale fence', () => {
    const journal = store()
    for (const at of ['2026-08-13T01:00:00.000Z', '2026-08-13T01:00:01.000Z', '2026-08-13T01:00:02.000Z'])
      journal.recordProviderFailure({ ...circuit, detail: 'Network failure.', at })
    const claim = (workerId: string, at: string) =>
      journal.reserveProviderStart({ ...circuit, workerId, at, leaseMilliseconds: 60_000 })
    const first = claim('first', '2026-08-13T01:05:02.000Z')
    if (first._tag !== 'Allowed' || first.canary === null) throw new Error('Expected a canary reservation.')
    const health = journal.listProviderCircuits()[0]!
    expect(journal.releaseProviderStart({ ...first.canary, at: '2026-08-13T01:05:03.000Z' })).toBe(true)
    expect(journal.listProviderCircuits()[0]).toMatchObject({ failures: health.failures, state: { _tag: 'Open' } })
    const second = claim('second', '2026-08-13T01:05:03.000Z')
    expect(second._tag).toBe('Allowed')
    expect(journal.releaseProviderStart({ ...first.canary, at: '2026-08-13T01:05:04.000Z' })).toBe(false)
    expect(claim('third', '2026-08-13T01:05:04.000Z')._tag).toBe('Paused')
  })
  it('does not spend a Task attempt while its provider circuit is open', () => {
    const journal = store()
    journal.syncRepositories([repositoryMapping()], '2026-08-13T01:00:00.000Z')
    journal.recordObservation({
      externalId: 'provider-paused-task',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: issueItem({ author: 'wolfstar-project' }),
    })

    for (let index = 0; index < 5; index += 1) {
      const minute = String(index).padStart(2, '0')
      const task = journal.claimNextIssueTriageTask('worker-1', `2026-08-13T01:${minute}:00.000Z`, 60_000)
      if (task === null) throw new Error('Expected the provider paused Task to remain queued.')
      expect(
        journal.failWorkerTask({
          taskId: task.id,
          workerId: task.state.workerId,
          fence: task.state.fence,
          at: `2026-08-13T01:${minute}:30.000Z`,
          reason: 'The Agent provider circuit is open.',
        }),
      ).toBe('Retrying')
    }
    expect(
      journal
        .listWorkflowEvents({ stream: 'worker_task', limit: 30 })
        .filter((event) => event.event === 'Claimed')
        .map((event) => event.attempt),
    ).toEqual([1, 1, 1, 1, 1])
  })

  it('does not spend Task attempts while another Task owns the provider canary', () => {
    const journal = store()
    journal.syncRepositories([repositoryMapping()], '2026-08-13T01:00:00.000Z')
    journal.recordObservation({
      externalId: 'provider-canary-worker-task',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: issueItem({ author: 'wolfstar-project' }),
    })
    journal.recordObservation({
      externalId: 'provider-canary-mutation-task',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    for (const at of ['2026-08-13T01:00:00.000Z', '2026-08-13T01:00:01.000Z', '2026-08-13T01:00:02.000Z'])
      journal.recordProviderFailure({ ...circuit, detail: 'Network error.', at })
    journal.reserveProviderStart({
      provider: circuit.provider,
      credential: circuit.credential,
      model: circuit.model,
      workerId: 'task-canary',
      at: '2026-08-13T01:05:02.000Z',
      leaseMilliseconds: 60_000,
    })
    const denial = journal.reserveProviderStart({
      provider: circuit.provider,
      credential: circuit.credential,
      model: circuit.model,
      workerId: 'task-racing',
      at: '2026-08-13T01:05:03.000Z',
      leaseMilliseconds: 60_000,
    })
    if (denial._tag !== 'Paused') throw new Error('Expected the active provider canary to pause another Task.')
    const reason = agentProviderFailureReason(circuit.provider, `${denial.reason} Retry after ${denial.retryAt}.`)

    for (let index = 0; index < 5; index += 1) {
      const second = 10 + index
      const mutationTask = journal.claimNextConflictTask(`mutation-${index}`, `2026-08-13T01:05:${second}.000Z`, 30_000)
      const workerTask = journal.claimNextIssueTriageTask(`worker-${index}`, `2026-08-13T01:05:${second}.000Z`, 30_000)
      if (workerTask === null || mutationTask === null)
        throw new Error('Expected provider-gated Tasks to remain queued.')
      expect(
        journal.failWorkerTask({
          taskId: workerTask.id,
          workerId: workerTask.state.workerId,
          fence: workerTask.state.fence,
          at: `2026-08-13T01:05:${second + 1}.000Z`,
          reason,
        }),
      ).toBe('Retrying')
      expect(
        journal.failTask({
          taskId: mutationTask.id,
          workerId: mutationTask.state.workerId,
          fence: mutationTask.state.fence,
          at: `2026-08-13T01:05:${second + 1}.000Z`,
          reason,
        }),
      ).toBe('Retrying')
    }
    expect(
      journal
        .listWorkflowEvents({ stream: 'worker_task', limit: 30 })
        .filter((event) => event.event === 'Claimed' && event.itemNumber === 12)
        .map((event) => event.attempt),
    ).toEqual([1, 1, 1, 1, 1])
    expect(
      journal
        .listWorkflowEvents({ stream: 'task', limit: 30 })
        .filter((event) => event.event === 'Claimed' && event.itemNumber === 24)
        .map((event) => event.attempt),
    ).toEqual([1, 1, 1, 1, 1])
  })

  it('keeps an open circuit across a journal restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wolfstar-provider-circuit-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'journal.sqlite')
    closeSync(openSync(path, 'w'))
    const first = openJournalStore(path)
    stores.push(first)
    for (const at of ['2026-08-13T01:00:00.000Z', '2026-08-13T01:00:01.000Z', '2026-08-13T01:00:02.000Z'])
      first.recordProviderFailure({ ...circuit, detail: 'Network error.', at })
    first.close()
    stores.splice(stores.indexOf(first), 1)

    const restarted = openJournalStore(path)
    stores.push(restarted)
    expect(
      restarted.providerCanStart({
        provider: circuit.provider,
        credential: circuit.credential,
        at: '2026-08-13T01:00:03.000Z',
      }),
    ).toBe(false)
    expect(restarted.listProviderCircuits()[0]?.state._tag).toBe('Open')
  })

  it('opens after three stable failures and permits one half-open canary', () => {
    const journal = store()
    for (const [index, at] of [
      '2026-08-13T01:00:00.000Z',
      '2026-08-13T01:00:10.000Z',
      '2026-08-13T01:00:20.000Z',
    ].entries()) {
      journal.recordProviderFailure({
        ...circuit,
        detail: `Network error request-id-${index + 1}`,
        at,
      })
    }

    expect(journal.listProviderCircuits()).toMatchObject([
      {
        ...circuit,
        failures: 3,
        state: { _tag: 'Open', retryAt: '2026-08-13T01:05:20.000Z' },
        lastDetail: 'The Agent provider reported a network failure.',
      },
    ])
    expect(
      journal.providerCanStart({
        provider: circuit.provider,
        credential: circuit.credential,
        at: '2026-08-13T01:05:19.000Z',
      }),
    ).toBe(false)
    expect(
      journal.providerCanStart({
        provider: circuit.provider,
        credential: circuit.credential,
        at: '2026-08-13T01:05:20.000Z',
      }),
    ).toBe(true)

    const canary = journal.reserveProviderStart({
      provider: circuit.provider,
      credential: circuit.credential,
      model: circuit.model,
      workerId: 'task-canary',
      at: '2026-08-13T01:05:20.000Z',
      leaseMilliseconds: 60_000,
    })
    expect(canary).toMatchObject({ _tag: 'Allowed', canary: { workerId: 'task-canary', fence: 1 } })
    expect(
      journal.reserveProviderStart({
        provider: circuit.provider,
        credential: circuit.credential,
        model: circuit.model,
        workerId: 'task-racing',
        at: '2026-08-13T01:05:21.000Z',
        leaseMilliseconds: 60_000,
      }),
    ).toMatchObject({ _tag: 'Paused' })

    if (canary._tag !== 'Allowed' || canary.canary === null) throw new Error('Expected one half-open canary.')
    expect(
      journal.recordProviderSuccess({
        provider: circuit.provider,
        credential: circuit.credential,
        model: circuit.model,
        workerId: canary.canary.workerId,
        canaryCircuitId: canary.canary.circuitId,
        canaryFence: canary.canary.fence,
        at: '2026-08-13T01:05:30.000Z',
      }),
    ).toBe(1)
    expect(journal.listProviderCircuits()[0]).toMatchObject({
      failures: 0,
      state: { _tag: 'Closed' },
    })
  })

  it('reopens immediately when its half-open canary fails', () => {
    const journal = store()
    for (const at of ['2026-08-13T01:00:00.000Z', '2026-08-13T01:00:01.000Z', '2026-08-13T01:00:02.000Z']) {
      journal.recordProviderFailure({ ...circuit, detail: 'Network error.', at })
    }
    const canary = journal.reserveProviderStart({
      provider: circuit.provider,
      credential: circuit.credential,
      model: circuit.model,
      workerId: 'task-canary',
      at: '2026-08-13T01:05:02.000Z',
      leaseMilliseconds: 60_000,
    })
    if (canary._tag !== 'Allowed' || canary.canary === null) throw new Error('Expected one half-open canary.')

    journal.recordProviderFailure({
      ...circuit,
      detail: 'Network error request-id-different.',
      workerId: canary.canary.workerId,
      canaryCircuitId: canary.canary.circuitId,
      canaryFence: canary.canary.fence,
      at: '2026-08-13T01:05:12.000Z',
    })

    expect(journal.listProviderCircuits()[0]).toMatchObject({
      failures: 4,
      state: { _tag: 'Open', retryAt: '2026-08-13T01:10:12.000Z' },
    })
    expect(journal.listWorkflowEvents({ stream: 'provider_circuit', limit: 20 }).map((event) => event.event)).toEqual([
      'Opened',
      'CanaryClaimed',
      'Opened',
      'FailureObserved',
      'FailureObserved',
    ])
  })

  it('closes only the failure class owned by a half-open canary', () => {
    const journal = store()
    for (const failureClass of ['network', 'authentication'] as const) {
      for (const at of ['2026-08-13T01:00:00.000Z', '2026-08-13T01:00:01.000Z', '2026-08-13T01:00:02.000Z'])
        journal.recordProviderFailure({ ...circuit, failureClass, detail: `${failureClass} failure.`, at })
    }
    const canary = journal.reserveProviderStart({
      provider: circuit.provider,
      credential: circuit.credential,
      model: circuit.model,
      workerId: 'task-canary',
      at: '2026-08-13T01:05:02.000Z',
      leaseMilliseconds: 60_000,
    })
    if (canary._tag !== 'Allowed' || canary.canary === null) throw new Error('Expected one half-open canary.')

    expect(
      journal.recordProviderSuccess({
        provider: circuit.provider,
        credential: circuit.credential,
        model: circuit.model,
        workerId: canary.canary.workerId,
        canaryCircuitId: canary.canary.circuitId,
        canaryFence: canary.canary.fence,
        at: '2026-08-13T01:05:03.000Z',
      }),
    ).toBe(1)
    expect(
      journal
        .listProviderCircuits()
        .map((entry) => entry.state._tag)
        .sort(),
    ).toEqual(['Closed', 'Open'])
  })
})
