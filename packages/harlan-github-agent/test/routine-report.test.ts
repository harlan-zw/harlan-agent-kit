import type { GitHubIssuePublisher } from '../src/github.ts'
import type { Candidate } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { createRoutineReportController, isRoutineTrackingIssue, routineReportBody, routineReportCommand, trackingIssueBody, trackingIssueTitle } from '../src/routine-report-controller.ts'
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
    findRoutineTrackingIssue: async () => ok(null),
    findIssueCommentByMarker: async () => ok(null),
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

  it('includes every saved result so a report does not hide what was found', () => {
    const found: Candidate[] = [{
      id: `${runId}:src/store.ts#openRoutineRun`,
      routineId,
      runId,
      fingerprint: 'src/store.ts#openRoutineRun',
      title: 'Fixture title',
      target: 'src/store.ts',
      claim: 'The scheduler can open the same run twice.',
      verification: 'pnpm vitest run test/routine-controller.test.ts',
      estimatedChangedFiles: 2,
      result: { _tag: 'Proposed', pullRequest: null },
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
    }]
    const body = routineReportBody(
      { scheduledFor: '2026-08-27T07:00:00.000Z' },
      { _tag: 'Completed', evidence: 'pr-triage | 1 found | 1 new' },
      found,
    )

    expect(body).toContain('The scheduler can open the same run twice.')
    expect(body).toContain('src/store.ts')
    expect(body).toContain('pnpm vitest run test/routine-controller.test.ts')
  })

  it('names the tracking issue after the routine and its repository', () => {
    expect(trackingIssueTitle('sentry-checkin', 'harlan-zw/example'))
      .toBe('sentry-checkin: run log for harlan-zw/example')
  })

  it('recognises only the canonical tracking issue for a Routine label', () => {
    const labels = ['routine:sentry-checkin']
    expect(isRoutineTrackingIssue({
      repository: 'harlan-zw/example',
      title: trackingIssueTitle('sentry-checkin', 'harlan-zw/example'),
      body: trackingIssueBody('sentry-checkin'),
      labels,
    })).toBe(true)
    expect(isRoutineTrackingIssue({
      repository: 'harlan-zw/example',
      title: trackingIssueTitle('sentry-checkin', 'harlan-zw/example'),
      body: 'Candidate details.',
      labels,
    })).toBe(false)
  })
})

describe('publishing the run log', () => {
  it('opens the tracking issue on the first run and comments on it', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      store.recordCandidates({
        routineId,
        runId,
        candidates: [{
          fingerprint: 'src/store.ts#openRoutineRun',
          title: 'Fixture title',
          target: 'src/store.ts',
          claim: 'The scheduler can open the same run twice.',
          verification: 'pnpm vitest run test/routine-controller.test.ts',
          estimatedChangedFiles: 2,
        }],
        at: now().toISOString(),
      })
      stage(store, { _tag: 'Completed', evidence: 'pr-triage | 2 found' })
      const calls: Calls = { issues: [], comments: [] }

      const results = await createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
        .publishPending(new AbortController().signal)

      expect(results).toEqual([{ _tag: 'Ok', value: { repository: 'harlan-zw/example', issueNumber: 42 } }])
      expect(calls.issues).toEqual(['pr-triage: run log for harlan-zw/example'])
      expect(calls.comments[0]?.body).toContain('2 found')
      expect(calls.comments[0]?.body).toContain('The scheduler can open the same run twice.')
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

  it('tries a failed report once per pass and remembers no tracking issue', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, { _tag: 'Completed', evidence: 'first run' })
      const refusing: GitHubIssuePublisher = {
        createIssue: async () => ok({ number: 42, url: 'https://github.com/harlan-zw/example/issues/42' }),
        createComment: async () => ({ _tag: 'Err' as const, error: { repository: 'harlan-zw/example', message: 'GitHub returned 502.' } }),
        findOpenIssueByFingerprint: async () => ok(null),
        findRoutineTrackingIssue: async () => ok(null),
        findIssueCommentByMarker: async () => ok(null),
      }

      const failed = await createRoutineReportController({ github: refusing, now, store, workerId: 'reporter' })
        .publishPending(new AbortController().signal)

      expect(failed).toHaveLength(1)
      expect(failed[0]?._tag).toBe('Err')
      expect(store.listRoutines('harlan-zw/example')[0]?.trackingIssueNumber).toBeNull()
    }
    finally {
      store.close()
    }
  })

  it('adopts unknown issue and comment writes without creating duplicates', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, { _tag: 'Completed', evidence: 'first run' })
      let issue: { number: number, url: string } | null = null
      let comment: { id: number } | null = null
      let issueWrites = 0
      let commentWrites = 0
      const github: GitHubIssuePublisher = {
        findOpenIssueByFingerprint: async () => ok(null),
        findRoutineTrackingIssue: async () => ok(issue),
        findIssueCommentByMarker: async () => ok(comment),
        createIssue: async () => {
          issueWrites += 1
          issue = { number: 42, url: 'https://github.com/harlan-zw/example/issues/42' }
          return { _tag: 'Err', error: { repository: 'harlan-zw/example', message: 'The issue response was lost.' } }
        },
        createComment: async () => {
          commentWrites += 1
          comment = { id: 900 }
          return { _tag: 'Err', error: { repository: 'harlan-zw/example', message: 'The comment response was lost.' } }
        },
      }
      const controller = createRoutineReportController({ github, now, store, workerId: 'reporter' })

      await controller.publishPending(new AbortController().signal)
      await controller.publishPending(new AbortController().signal)
      const recovered = await controller.publishPending(new AbortController().signal)

      expect({ issueWrites, commentWrites }).toEqual({ issueWrites: 1, commentWrites: 1 })
      expect(recovered).toEqual([{ _tag: 'Ok', value: { repository: 'harlan-zw/example', issueNumber: 42 } }])
    }
    finally {
      store.close()
    }
  })

  it('publishes another repository after one report fails', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, { _tag: 'Completed', evidence: 'first run' })
      const working = repositoryMapping({ github: 'harlan-zw/working', checkout: '/home/harlan/pkg/working' })
      store.syncRepositories([repositoryMapping(), working], '2026-08-27T07:10:01.000Z')
      store.setRepositoryWritesEnabled(working.github, true)
      store.syncRoutines({
        repository: working.github,
        specSha: 'def456',
        entries: [{ name: 'pr-triage', crons: ['0 8 * * *'], timeZone: 'UTC', mode: 'propose', enabled: true }],
        at: '2026-08-27T07:10:02.000Z',
      })
      const workingRoutineId = `${working.github}:pr-triage`
      const workingRun = store.openRoutineRun({
        routineId: workingRoutineId,
        scheduledFor: '2026-08-27T08:00:00.000Z',
        specSha: 'def456',
        at: '2026-08-27T07:10:03.000Z',
      })
      if (workingRun === null)
        throw new Error('the second run must open')
      store.stageRoutineReport({
        command: routineReportCommand({
          repository: working.github,
          routineId: workingRoutineId,
          routineName: 'pr-triage',
          run: workingRun,
          report: { _tag: 'Completed', evidence: 'second run' },
        }),
        at: '2026-08-27T07:10:04.000Z',
      })
      const comments: Calls['comments'] = []
      const github: GitHubIssuePublisher = {
        createIssue: async input => input.repository.github === 'harlan-zw/example'
          ? { _tag: 'Err' as const, error: { repository: input.repository.github, message: 'Issues are disabled.' } }
          : ok({ number: 42, url: 'https://github.com/harlan-zw/working/issues/42' }),
        createComment: async (input) => {
          comments.push({ issueNumber: input.issueNumber, body: input.body })
          return ok({ id: 900 + comments.length })
        },
        findOpenIssueByFingerprint: async () => ok(null),
        findRoutineTrackingIssue: async () => ok(null),
        findIssueCommentByMarker: async () => ok(null),
      }

      const results = await createRoutineReportController({ github, now, store, workerId: 'reporter' })
        .publishPending(new AbortController().signal)

      expect(results).toEqual([
        { _tag: 'Err', error: 'harlan-zw/example: Issues are disabled.' },
        { _tag: 'Ok', value: { repository: 'harlan-zw/working', issueNumber: 42 } },
      ])
      expect(comments).toHaveLength(1)
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

  it('keeps restart unsafe while a report write holds its lease', () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, { _tag: 'Completed', evidence: 'first run' })
      expect(store.claimNextRoutineReport('reporter', now().toISOString(), 60_000)).not.toBeNull()
      store.pauseAgents(now().toISOString())

      expect(store.getDashboardSnapshot(now().toISOString()).agentControl).toMatchObject({ safeToRestart: false })
    }
    finally {
      store.close()
    }
  })
})
