import type { GitHubIssuePublisher } from '../src/github.ts'
import { describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { createRoutineReportController, routineReportBody, routineReportCommand, trackingIssueTitle } from '../src/routine-report-controller.ts'
import { openJournalStore } from '../src/store.ts'
import { repositoryMapping } from './fixtures.ts'

const now = () => new Date('2026-08-27T07:10:00.000Z')
const routineId = 'harlan-zw/example:pr-triage'
const runId = `${routineId}:2026-08-27T07:00:00.000Z`

function seed(store: ReturnType<typeof openJournalStore>): void {
  store.syncRepositories([repositoryMapping()], '2026-08-27T00:00:00.000Z')
  store.setRepositoryWritesEnabled('harlan-zw/example', true)
  store.syncRoutines({
    repository: 'harlan-zw/example',
    specSha: 'abc123',
    entries: [{ name: 'pr-triage', crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'propose', enabled: true }],
    at: '2026-08-27T00:00:00.000Z',
  })
  store.openRoutineRun({
    routineId,
    scheduledFor: '2026-08-27T07:00:00.000Z',
    specSha: 'abc123',
    at: '2026-08-27T07:00:05.000Z',
  })
}

function stage(store: ReturnType<typeof openJournalStore>, report: Parameters<typeof routineReportCommand>[0]['report']): boolean {
  return store.stageRoutineReport({
    command: routineReportCommand({
      repository: 'harlan-zw/example',
      routineId,
      routineName: 'pr-triage',
      run: { id: runId, scheduledFor: '2026-08-27T07:00:00.000Z' },
      report,
    }),
    at: now().toISOString(),
  })
}

interface Calls {
  issues: string[]
  comments: Array<{ issueNumber: number, body: string }>
}

function publisher(calls: Calls, issueNumber = 42): GitHubIssuePublisher {
  return {
    createIssue: async (input) => {
      calls.issues.push(input.title)
      return ok({ number: issueNumber, url: `https://github.com/harlan-zw/example/issues/${issueNumber}` })
    },
    createComment: async (input) => {
      calls.comments.push({ issueNumber: input.issueNumber, body: input.body })
      return ok({ id: 900 + calls.comments.length })
    },
    findOpenIssueByFingerprint: async () => ok(null),
  }
}

describe('writing what one run did', () => {
  it('says what a completed run found', () => {
    const body = routineReportBody(
      { scheduledFor: '2026-08-27T07:00:00.000Z' },
      { _tag: 'Completed', evidence: 'pr-triage | 0 found | 0 new' },
    )

    expect(body).toContain('2026-08-27T07:00:00.000Z')
    expect(body).toContain('0 found')
  })

  it('says why a run was skipped, because a skip leaves no other trace', () => {
    const body = routineReportBody(
      { scheduledFor: '2026-08-25T07:00:00.000Z' },
      { _tag: 'Skipped', reason: 'This run was due more than 6 hours ago, so it was skipped.' },
    )

    expect(body).toContain('Skipped')
    expect(body).toContain('more than 6 hours ago')
  })

  it('names the tracking issue after the routine and its repository', () => {
    expect(trackingIssueTitle('sentry-checkin', 'harlan-zw/example'))
      .toBe('sentry-checkin: run log for harlan-zw/example')
  })
})

describe('publishing the run log', () => {
  it('opens the tracking issue on the first run and comments on it', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, { _tag: 'Completed', evidence: 'pr-triage | 2 found' })
      const calls: Calls = { issues: [], comments: [] }

      const results = await createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
        .publishPending(new AbortController().signal)

      expect(results).toEqual([{ _tag: 'Ok', value: { repository: 'harlan-zw/example', issueNumber: 42 } }])
      expect(calls.issues).toEqual(['pr-triage: run log for harlan-zw/example'])
      expect(calls.comments[0]?.body).toContain('2 found')
    }
    finally {
      store.close()
    }
  })

  it('reuses the tracking issue on the next run', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, { _tag: 'Completed', evidence: 'first run' })
      const calls: Calls = { issues: [], comments: [] }
      const controller = createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
      await controller.publishPending(new AbortController().signal)

      store.openRoutineRun({
        routineId,
        scheduledFor: '2026-08-28T07:00:00.000Z',
        specSha: 'abc123',
        at: '2026-08-28T07:00:05.000Z',
      })
      store.stageRoutineReport({
        command: routineReportCommand({
          repository: 'harlan-zw/example',
          routineId,
          routineName: 'pr-triage',
          run: { id: `${routineId}:2026-08-28T07:00:00.000Z`, scheduledFor: '2026-08-28T07:00:00.000Z' },
          report: { _tag: 'Completed', evidence: 'second run' },
        }),
        at: '2026-08-28T07:05:00.000Z',
      })
      await controller.publishPending(new AbortController().signal)

      expect(calls.issues).toHaveLength(1)
      expect(calls.comments).toHaveLength(2)
      expect(calls.comments.every(comment => comment.issueNumber === 42)).toBe(true)
    }
    finally {
      store.close()
    }
  })

  it('writes one report per run however often it is staged', () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)

      expect(stage(store, { _tag: 'Completed', evidence: 'first' })).toBe(true)
      expect(stage(store, { _tag: 'Completed', evidence: 'again' })).toBe(false)
    }
    finally {
      store.close()
    }
  })

  it('remembers no tracking issue when the comment failed, so a retry does not log twice', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, { _tag: 'Completed', evidence: 'first run' })
      const refusing: GitHubIssuePublisher = {
        createIssue: async () => ok({ number: 42, url: 'https://github.com/harlan-zw/example/issues/42' }),
        createComment: async () => ({ _tag: 'Err' as const, error: { repository: 'harlan-zw/example', message: 'GitHub returned 502.' } }),
        findOpenIssueByFingerprint: async () => ok(null),
      }

      const failed = await createRoutineReportController({ github: refusing, now, store, workerId: 'reporter' })
        .publishPending(new AbortController().signal)

      expect(failed[0]?._tag).toBe('Err')
      expect(store.listRoutines('harlan-zw/example')[0]?.trackingIssueNumber).toBeNull()
    }
    finally {
      store.close()
    }
  })

  it('writes nothing when the repository has writes turned off', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, { _tag: 'Completed', evidence: 'first run' })
      store.setRepositoryWritesEnabled('harlan-zw/example', false)
      const calls: Calls = { issues: [], comments: [] }

      const results = await createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
        .publishPending(new AbortController().signal)

      expect(results).toEqual([])
      expect(calls.comments).toEqual([])
    }
    finally {
      store.close()
    }
  })
})
