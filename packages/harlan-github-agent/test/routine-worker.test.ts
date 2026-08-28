import type { AgentEvent } from '../src/agent-provider.ts'
import type { ClaimedRoutineRun } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { createAgentActivityLog } from '../src/agent-activity.ts'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { ok } from '../src/result.ts'
import { createRoutineScanWorker, routineScanPrompt } from '../src/routine-worker.ts'
import { openJournalStore } from '../src/store.ts'
import { repositoryMapping } from './fixtures.ts'

const now = () => new Date('2026-08-27T07:05:00.000Z')

function claimStoredRun(store: ReturnType<typeof openJournalStore>, at = now().toISOString()): ClaimedRoutineRun {
  const task = store.claimNextRoutineRun('worker-1', at, 60 * 60_000)
  if (task === null)
    throw new Error('Expected a queued Routine run.')
  return task
}

function scanning(answer: unknown, capture?: { prompts: string[] }) {
  return {
    name: 'codex' as const,
    runTurn: (request: { prompt: string }) => {
      capture?.prompts.push(request.prompt)
      return (async function* (): AsyncIterable<AgentEvent> {
        yield { _tag: 'SessionStarted', sessionId: 'session-1' }
        yield { _tag: 'Message', text: JSON.stringify(answer) }
        yield { _tag: 'TurnCompleted' }
      })()
    },
  }
}

function workerFor(
  store: ReturnType<typeof openJournalStore>,
  provider: ReturnType<typeof scanning>,
  maximumChangedFiles?: number,
  activityLog?: ReturnType<typeof createAgentActivityLog>,
) {
  return createRoutineScanWorker({
    ...(activityLog === undefined ? {} : { activityLog }),
    logger: { error: () => undefined, info: () => undefined },
    ...(maximumChangedFiles === undefined ? {} : { maximumChangedFiles }),
    now,
    runtime: () => ({ profile: CODEX_AGENT_PROFILE, provider }),
    store,
    workspaces: { prepareRoutine: async () => ok({ path: '/tmp/routine', baseSha: 'abc123', headSha: 'abc123' }) },
  })
}

function seed(store: ReturnType<typeof openJournalStore>): void {
  store.syncRepositories([repositoryMapping()], '2026-08-27T00:00:00.000Z')
  store.syncRoutines({
    repository: 'harlan-zw/example',
    specSha: 'abc123',
    entries: [{ name: 'pr-triage', crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'propose', enabled: true }],
    at: '2026-08-27T00:00:00.000Z',
  })
  store.openRoutineRun({
    routineId: 'harlan-zw/example:pr-triage',
    scheduledFor: '2026-08-27T07:00:00.000Z',
    specSha: 'abc123',
    at: '2026-08-27T07:00:05.000Z',
  })
}

const candidate = {
  fingerprint: 'src/store.ts#openRoutineRun',
  target: 'src/store.ts',
  claim: 'This helper is never called.',
  verification: 'pnpm test',
  estimatedChangedFiles: 1,
}

describe('building the scan prompt', () => {
  it('names the skill that answers the routine', () => {
    const prompt = routineScanPrompt({ mode: 'propose', name: 'sentry-checkin', rejected: [], repository: 'harlan-zw/example' })

    expect(prompt).toContain('harlan-agent-kit:sentry-checkin')
  })

  it('says the turn is read only', () => {
    const prompt = routineScanPrompt({ mode: 'propose', name: 'pr-triage', rejected: [], repository: 'harlan-zw/example' })

    expect(prompt).toContain('read only')
  })

  it('carries every prior rejection and its reason', () => {
    const prompt = routineScanPrompt({
      mode: 'propose',
      name: 'pr-triage',
      rejected: [{
        id: 'c1',
        routineId: 'r1',
        runId: 'run-1',
        fingerprint: 'src/old.ts',
        target: 'src/old.ts',
        claim: 'unused',
        verification: 'pnpm test',
        estimatedChangedFiles: 1,
        result: { _tag: 'Rejected', reason: 'This file is generated.' },
        createdAt: '',
        updatedAt: '',
      }],
      repository: 'harlan-zw/example',
    })

    expect(prompt).toContain('src/old.ts: This file is generated.')
  })

  it('leaves a Candidate that was never rejected out of the memory', () => {
    const prompt = routineScanPrompt({
      mode: 'propose',
      name: 'pr-triage',
      rejected: [{
        id: 'c1',
        routineId: 'r1',
        runId: 'run-1',
        fingerprint: 'src/open.ts',
        target: 'src/open.ts',
        claim: 'unused',
        verification: 'pnpm test',
        estimatedChangedFiles: 1,
        result: { _tag: 'Proposed', pullRequest: null },
        createdAt: '',
        updatedAt: '',
      }],
      repository: 'harlan-zw/example',
    })

    expect(prompt).toContain('Nothing has been rejected yet.')
  })

  it('tells a report routine that nothing it proposes gets built', () => {
    const prompt = routineScanPrompt({ mode: 'report', name: 'pr-triage', rejected: [], repository: 'harlan-zw/example' })

    expect(prompt).toContain('reports only')
  })
})

describe('running one scan', () => {
  it('reports live progress and provider activity', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const task = claimStoredRun(store)
      const activityLog = createAgentActivityLog()
      const provider = {
        name: 'codex' as const,
        runTurn: () => (async function* (): AsyncIterable<AgentEvent> {
          yield { _tag: 'SessionStarted', sessionId: 'session-1' }
          yield { _tag: 'Reasoning', text: 'Checking the repository.' }
          yield { _tag: 'CommandCompleted', command: 'pnpm test', output: 'passed', exitCode: 0 }
          yield { _tag: 'Message', text: JSON.stringify({ candidates: [] }) }
          yield { _tag: 'TurnCompleted' }
        })(),
      }

      const result = await workerFor(store, provider, undefined, activityLog)
        .run(task, new AbortController().signal)

      expect(result).toMatchObject({ _tag: 'Ok' })
      expect(activityLog.read(task.id)).toEqual([
        { _tag: 'Reasoning', at: now().toISOString(), text: 'Checking the repository.' },
        { _tag: 'Command', at: now().toISOString(), command: 'pnpm test', output: 'passed', exitCode: 0 },
      ])
      expect(store.listRoutineRuns(task.routineId)[0]).toMatchObject({
        progress: { percent: 85, label: 'Preparing the Routine result' },
      })
    }
    finally {
      store.close()
    }
  })

  it('records what the scan found', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const result = await workerFor(store, scanning({ candidates: [candidate] }))
        .run(claimStoredRun(store), new AbortController().signal)

      expect(result).toMatchObject({ _tag: 'Ok' })
      expect(store.listCandidates('harlan-zw/example:pr-triage')).toMatchObject([{ fingerprint: candidate.fingerprint }])
    }
    finally {
      store.close()
    }
  })

  it('drops a proposal larger than the file limit before it reaches the ledger', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      await workerFor(store, scanning({
        candidates: [candidate, { ...candidate, fingerprint: 'src/big.ts', estimatedChangedFiles: 40 }],
      })).run(claimStoredRun(store), new AbortController().signal)

      expect(store.listCandidates('harlan-zw/example:pr-triage').map(entry => entry.fingerprint))
        .toEqual([candidate.fingerprint])
    }
    finally {
      store.close()
    }
  })

  it('records a Candidate once across two runs', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const worker = workerFor(store, scanning({ candidates: [candidate] }))
      const firstTask = claimStoredRun(store)
      await worker.run(firstTask, new AbortController().signal)
      store.completeRoutineRun({
        taskId: firstTask.id,
        workerId: firstTask.state.workerId,
        fence: firstTask.state.fence,
        at: '2026-08-27T07:06:00.000Z',
        evidence: 'First scan completed.',
      })

      store.openRoutineRun({
        routineId: 'harlan-zw/example:pr-triage',
        scheduledFor: '2026-08-28T07:00:00.000Z',
        specSha: 'abc123',
        at: '2026-08-28T07:00:05.000Z',
      })
      const secondTask = claimStoredRun(store, '2026-08-28T07:05:00.000Z')
      const second = await worker.run(
        secondTask,
        new AbortController().signal,
      )

      expect(second).toMatchObject({ _tag: 'Ok' })
      expect(store.listCandidates('harlan-zw/example:pr-triage')).toHaveLength(1)
    }
    finally {
      store.close()
    }
  })

  it('sends a prior rejection back to the next scan', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const capture = { prompts: [] as string[] }
      await workerFor(store, scanning({ candidates: [candidate] }, capture))
        .run(claimStoredRun(store), new AbortController().signal)

      expect(capture.prompts[0]).toContain('Nothing has been rejected yet.')
    }
    finally {
      store.close()
    }
  })

  it('fails when the scan answers something other than JSON', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const provider = {
        name: 'codex' as const,
        runTurn: () => (async function* (): AsyncIterable<AgentEvent> {
          yield { _tag: 'Message', text: 'I had a look and everything seems fine.' }
          yield { _tag: 'TurnCompleted' }
        })(),
      }
      const result = await workerFor(store, provider).run(claimStoredRun(store), new AbortController().signal)

      expect(result._tag).toBe('Err')
    }
    finally {
      store.close()
    }
  })
})

describe('claiming a Routine run', () => {
  it('leases one queued run and never the same one twice', () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)

      const first = store.claimNextRoutineRun('worker-1', '2026-08-27T07:05:00.000Z', 60_000)
      const second = store.claimNextRoutineRun('worker-2', '2026-08-27T07:05:01.000Z', 60_000)

      expect(first).toMatchObject({ name: 'pr-triage', state: { _tag: 'Running', workerId: 'worker-1' } })
      expect(second).toBeNull()
    }
    finally {
      store.close()
    }
  })

  it('returns an expired lease to the queue with a new fence', () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const first = store.claimNextRoutineRun('worker-1', '2026-08-27T07:05:00.000Z', 60_000)

      const second = store.claimNextRoutineRun('worker-2', '2026-08-27T09:00:00.000Z', 60_000)

      expect(second?.state.workerId).toBe('worker-2')
      expect(second?.state.fence).toBeGreaterThan(first?.state.fence ?? 0)
    }
    finally {
      store.close()
    }
  })

  it('refuses a heartbeat from a worker that lost the lease', () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const claimed = store.claimNextRoutineRun('worker-1', '2026-08-27T07:05:00.000Z', 60_000)

      const renewed = store.heartbeatRoutineRun({
        taskId: claimed?.id ?? '',
        workerId: 'worker-2',
        fence: claimed?.state.fence ?? 0,
        at: '2026-08-27T07:05:30.000Z',
        leaseMilliseconds: 60_000,
      })

      expect(renewed).toBe(false)
    }
    finally {
      store.close()
    }
  })

  it('retries a failed run until its attempts run out', () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const outcomes: string[] = []
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const claimed = store.claimNextRoutineRun('worker-1', `2026-08-27T0${7 + attempt}:05:00.000Z`, 60_000)
        if (claimed === null)
          break
        outcomes.push(store.failRoutineRun({
          taskId: claimed.id,
          workerId: 'worker-1',
          fence: claimed.state.fence,
          at: `2026-08-27T0${7 + attempt}:06:00.000Z`,
          reason: 'The scan agent failed.',
        }))
      }

      expect(outcomes).toEqual(['Retrying', 'Retrying', 'Failed'])
    }
    finally {
      store.close()
    }
  })

  it('claims nothing for a disabled Routine', () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      store.syncRoutines({
        repository: 'harlan-zw/example',
        specSha: 'abc123',
        entries: [{ name: 'pr-triage', crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'propose', enabled: false }],
        at: '2026-08-27T07:01:00.000Z',
      })

      expect(store.claimNextRoutineRun('worker-1', '2026-08-27T07:05:00.000Z', 60_000)).toBeNull()
    }
    finally {
      store.close()
    }
  })
})
