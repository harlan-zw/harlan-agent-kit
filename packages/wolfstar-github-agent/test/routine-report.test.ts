import type { GitHubIssuePublisher } from '../src/github.ts'
import type { Candidate, RoutineName } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import {
  createRoutineReportController,
  isRoutineTrackingIssue,
  routineReportBody,
  routineReportCommand,
  trackingIssueBody,
  trackingIssueTitle,
} from '../src/routine-report-controller.ts'
import { openJournalStore } from '../src/store.ts'
import { repositoryMapping } from './fixtures.ts'

const now = () => new Date('2026-08-27T07:10:00.000Z')
const routineId = 'wolfstar-project/example:pr-triage'
const runId = `${routineId}:2026-08-27T07:00:00.000Z`

it('replaces a staged result when a retry finishes with newer evidence', () => {
  const store = openJournalStore(':memory:')
  seed(store)
  stage(store, { _tag: 'Completed', evidence: 'First attempt', detail: 'Provider was unavailable.' })
  stage(store, { _tag: 'Completed', evidence: 'Final attempt', detail: 'The scan found no issues.' })
  settleRun(store, runId)
  const report = store.claimNextRoutineReport('publisher', now().toISOString(), 60_000)
  expect(report?.body).toContain('Final attempt')
  expect(report?.body).not.toContain('First attempt')
  store.close()
})

it('publishes the final failure when a retried scan staged an earlier report', () => {
  const store = openJournalStore(':memory:')
  seed(store)
  stage(store, { _tag: 'Failed', reason: 'Weekly/Monthly Limit Exhausted' })
  failRun(store, runId, 'GitHub requests reached their rate limit.')
  const report = store.claimNextRoutineReport('publisher', now().toISOString(), 60_000)
  expect(report?.body).toContain('GitHub requests reached their rate limit.')
  expect(report?.body).not.toContain('Weekly/Monthly Limit Exhausted')
  store.close()
})

function seed(store: ReturnType<typeof openJournalStore>, name: RoutineName = 'pr-triage'): void {
  store.syncRepositories([repositoryMapping()], '2026-08-27T00:00:00.000Z')
  store.setRepositoryWritesEnabled('wolfstar-project/example', true)
  store.syncRoutines({
    repository: 'wolfstar-project/example',
    specSha: 'abc123',
    entries: [{ name, crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'propose', enabled: true }],
    at: '2026-08-27T00:00:00.000Z',
  })
  store.openRoutineRun({
    routineId: `wolfstar-project/example:${name}`,
    scheduledFor: '2026-08-27T07:00:00.000Z',
    specSha: 'abc123',
    at: '2026-08-27T07:00:05.000Z',
  })
}

/** Settles a queued run the way the scheduler does, so its staged report may publish. */
function settleRun(store: ReturnType<typeof openJournalStore>, runId: string): void {
  const task = store.claimNextRoutineRun('scanner', now().toISOString(), 45 * 60_000)
  if (task === null || task.id !== runId) throw new Error(`Expected the queued Routine run ${runId}.`)
  store.completeRoutineRun({
    taskId: task.id,
    workerId: task.state.workerId,
    fence: task.state.fence,
    at: now().toISOString(),
    evidence: 'settled for publication',
  })
}

/** Fails a queued run on every attempt, the way a broken scan settles. */
function failRun(store: ReturnType<typeof openJournalStore>, runId: string, reason: string): void {
  for (;;) {
    const task = store.claimNextRoutineRun('scanner', now().toISOString(), 45 * 60_000)
    if (task === null || task.id !== runId) throw new Error(`Expected the queued Routine run ${runId}.`)
    if (
      store.failRoutineRun({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at: now().toISOString(),
        reason,
      }) === 'Failed'
    ) {
      return
    }
  }
}

function stage(
  store: ReturnType<typeof openJournalStore>,
  report: Parameters<typeof routineReportCommand>[0]['report'],
): boolean {
  return store.stageRoutineReport({
    command: routineReportCommand({
      repository: 'wolfstar-project/example',
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
  updates?: Array<{ title: string; body: string }>
  comments: Array<{ issueNumber: number; body: string }>
}

function publisher(calls: Calls, issueNumber = 42): GitHubIssuePublisher {
  let created = false
  return {
    updateIssue: async (input) => {
      ;(calls.updates ??= []).push({ title: input.title, body: input.body })
      return ok(undefined)
    },
    createIssue: async (input) => {
      created = true
      calls.issues.push(input.title)
      return ok({ number: issueNumber, url: `https://github.com/wolfstar-project/example/issues/${issueNumber}` })
    },
    createComment: async (input) => {
      calls.comments.push({ issueNumber: input.issueNumber, body: input.body })
      return ok({ id: 900 + calls.comments.length })
    },
    findOpenIssueByFingerprint: async () => ok(null),
    findRoutineTrackingIssue: async () =>
      ok(
        created
          ? { number: issueNumber, url: `https://github.com/wolfstar-project/example/issues/${issueNumber}` }
          : null,
      ),
    findIssueCommentByMarker: async (input) =>
      ok(calls.comments.findIndex((comment) => comment.body.includes(input.marker)) < 0 ? null : { id: 901 }),
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
    const found: Candidate[] = [
      {
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
      },
    ]
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
    expect(trackingIssueTitle('sentry-checkin', 'wolfstar-project/example')).toBe(
      'sentry-checkin: run log for wolfstar-project/example',
    )
  })

  it('recognises only the canonical tracking issue for a Routine label', () => {
    const labels = ['routine:sentry-checkin']
    expect(
      isRoutineTrackingIssue({
        repository: 'wolfstar-project/example',
        title: trackingIssueTitle('sentry-checkin', 'wolfstar-project/example'),
        body: trackingIssueBody('sentry-checkin'),
        labels,
      }),
    ).toBe(true)
    expect(
      isRoutineTrackingIssue({
        repository: 'wolfstar-project/example',
        title: trackingIssueTitle('sentry-checkin', 'wolfstar-project/example'),
        body: 'Candidate details.',
        labels,
      }),
    ).toBe(false)
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
        candidates: [
          {
            fingerprint: 'src/store.ts#openRoutineRun',
            title: 'Fixture title',
            target: 'src/store.ts',
            claim: 'The scheduler can open the same run twice.',
            verification: 'pnpm vitest run test/routine-controller.test.ts',
            estimatedChangedFiles: 2,
          },
        ],
        at: now().toISOString(),
      })
      stage(store, { _tag: 'Completed', evidence: 'pr-triage | 2 found' })
      settleRun(store, runId)
      const calls: Calls = { issues: [], comments: [] }

      const results = await createRoutineReportController({
        github: publisher(calls),
        now,
        store,
        workerId: 'reporter',
      }).publishPending(new AbortController().signal)

      expect(results).toEqual([{ _tag: 'Ok', value: { repository: 'wolfstar-project/example', issueNumber: 42 } }])
      expect(calls.issues).toEqual(['pr-triage: run log for wolfstar-project/example'])
      expect(calls.comments[0]?.body).toContain('2 found')
      expect(calls.comments[0]?.body).toContain('The scheduler can open the same run twice.')
    } finally {
      store.close()
    }
  })

  it('reuses the tracking issue on the next run', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, { _tag: 'Completed', evidence: 'first run' })
      settleRun(store, runId)
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
          repository: 'wolfstar-project/example',
          routineId,
          routineName: 'pr-triage',
          run: { id: `${routineId}:2026-08-28T07:00:00.000Z`, scheduledFor: '2026-08-28T07:00:00.000Z' },
          report: { _tag: 'Completed', evidence: 'second run' },
        }),
        at: '2026-08-28T07:05:00.000Z',
      })
      settleRun(store, `${routineId}:2026-08-28T07:00:00.000Z`)
      await controller.publishPending(new AbortController().signal)

      expect(calls.issues).toHaveLength(1)
      expect(calls.comments).toHaveLength(2)
      expect(calls.comments.every((comment) => comment.issueNumber === 42)).toBe(true)
    } finally {
      store.close()
    }
  })

  it('does not restage identical evidence', () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)

      expect(stage(store, { _tag: 'Completed', evidence: 'first' })).toBe(true)
      expect(stage(store, { _tag: 'Completed', evidence: 'first' })).toBe(false)
    } finally {
      store.close()
    }
  })

  it('tries a failed report once per pass and remembers no tracking issue', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, { _tag: 'Completed', evidence: 'first run' })
      settleRun(store, runId)
      const refusing: GitHubIssuePublisher = {
        createIssue: async () => ok({ number: 42, url: 'https://github.com/wolfstar-project/example/issues/42' }),
        createComment: async () => ({
          _tag: 'Err' as const,
          error: { repository: 'wolfstar-project/example', message: 'GitHub returned 502.' },
        }),
        updateIssue: async () => ok(undefined),
        findOpenIssueByFingerprint: async () => ok(null),
        findRoutineTrackingIssue: async () => ok(null),
        findIssueCommentByMarker: async () => ok(null),
      }

      const failed = await createRoutineReportController({
        github: refusing,
        now,
        store,
        workerId: 'reporter',
      }).publishPending(new AbortController().signal)

      expect(failed).toHaveLength(1)
      expect(failed[0]?._tag).toBe('Err')
      expect(store.listRoutines('wolfstar-project/example')[0]?.trackingIssueNumber).toBeNull()
    } finally {
      store.close()
    }
  })

  it('leaves a report queued while GitHub holds a quota', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, { _tag: 'Completed', evidence: 'first run' })
      settleRun(store, runId)
      const calls: Calls = { issues: [], comments: [] }
      let held = true
      const controller = createRoutineReportController({
        canPublish: () => !held,
        github: publisher(calls),
        now,
        store,
        workerId: 'reporter',
      })

      expect(await controller.publishPending(new AbortController().signal)).toEqual([])
      expect(calls).toEqual({ issues: [], comments: [] })

      held = false
      expect(await controller.publishPending(new AbortController().signal)).toEqual([
        { _tag: 'Ok', value: { repository: 'wolfstar-project/example', issueNumber: 42 } },
      ])
    } finally {
      store.close()
    }
  })

  it('adopts unknown issue and comment writes without creating duplicates', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, { _tag: 'Completed', evidence: 'first run' })
      settleRun(store, runId)
      let issue: { number: number; url: string } | null = null
      let comment: { id: number } | null = null
      let issueWrites = 0
      let commentWrites = 0
      const github: GitHubIssuePublisher = {
        updateIssue: async () => ok(undefined),
        findOpenIssueByFingerprint: async () => ok(null),
        findRoutineTrackingIssue: async () => ok(issue),
        findIssueCommentByMarker: async () => ok(comment),
        createIssue: async () => {
          issueWrites += 1
          issue = { number: 42, url: 'https://github.com/wolfstar-project/example/issues/42' }
          return {
            _tag: 'Err',
            error: { repository: 'wolfstar-project/example', message: 'The issue response was lost.' },
          }
        },
        createComment: async () => {
          commentWrites += 1
          comment = { id: 900 }
          return {
            _tag: 'Err',
            error: { repository: 'wolfstar-project/example', message: 'The comment response was lost.' },
          }
        },
      }
      const controller = createRoutineReportController({ github, now, store, workerId: 'reporter' })

      await controller.publishPending(new AbortController().signal)
      await controller.publishPending(new AbortController().signal)
      const recovered = await controller.publishPending(new AbortController().signal)

      expect({ issueWrites, commentWrites }).toEqual({ issueWrites: 1, commentWrites: 1 })
      expect(recovered).toEqual([{ _tag: 'Ok', value: { repository: 'wolfstar-project/example', issueNumber: 42 } }])
    } finally {
      store.close()
    }
  })

  it('publishes another repository after one report fails', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, { _tag: 'Completed', evidence: 'first run' })
      const working = repositoryMapping({ github: 'wolfstar-project/working', checkout: '/home/wolfstar/pkg/working' })
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
      if (workingRun === null) throw new Error('the second run must open')
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
      settleRun(store, runId)
      settleRun(store, workingRun.id)
      const comments: Calls['comments'] = []
      const github: GitHubIssuePublisher = {
        createIssue: async (input) =>
          input.repository.github === 'wolfstar-project/example'
            ? { _tag: 'Err' as const, error: { repository: input.repository.github, message: 'Issues are disabled.' } }
            : ok({ number: 42, url: 'https://github.com/wolfstar-project/working/issues/42' }),
        createComment: async (input) => {
          comments.push({ issueNumber: input.issueNumber, body: input.body })
          return ok({ id: 900 + comments.length })
        },
        updateIssue: async () => ok(undefined),
        findOpenIssueByFingerprint: async () => ok(null),
        findRoutineTrackingIssue: async () => ok(null),
        findIssueCommentByMarker: async () => ok(null),
      }

      const results = await createRoutineReportController({ github, now, store, workerId: 'reporter' }).publishPending(
        new AbortController().signal,
      )

      expect(results).toEqual([
        { _tag: 'Err', error: 'wolfstar-project/example: Issues are disabled.' },
        { _tag: 'Ok', value: { repository: 'wolfstar-project/working', issueNumber: 42 } },
      ])
      expect(comments).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('writes nothing when the repository has writes turned off', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, { _tag: 'Completed', evidence: 'first run' })
      settleRun(store, runId)
      store.setRepositoryWritesEnabled('wolfstar-project/example', false)
      const calls: Calls = { issues: [], comments: [] }

      const results = await createRoutineReportController({
        github: publisher(calls),
        now,
        store,
        workerId: 'reporter',
      }).publishPending(new AbortController().signal)

      expect(results).toEqual([])
      expect(calls.comments).toEqual([])
    } finally {
      store.close()
    }
  })

  it('keeps restart unsafe while a report write holds its lease', () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, { _tag: 'Completed', evidence: 'first run' })
      settleRun(store, runId)
      expect(store.claimNextRoutineReport('reporter', now().toISOString(), 60_000)).not.toBeNull()
      store.pauseAgents(now().toISOString())

      expect(store.getDashboardSnapshot(now().toISOString()).agentControl).toMatchObject({ safeToRestart: false })
    } finally {
      store.close()
    }
  })
})

describe('daily check-in issues', () => {
  it.each([
    [{ severity: 'GREEN', coverage: 'complete' }, 'CLEAR'],
    [{ severity: 'AMBER', coverage: 'complete' }, 'ACTION NEEDED'],
    [{ severity: 'RED', coverage: 'complete' }, 'ACTION NEEDED'],
    [{ severity: 'GREEN', coverage: 'incomplete' }, 'BLOCKED'],
    [{ severity: 'RED', coverage: 'incomplete' }, 'BLOCKED'],
  ] as const)('publishes %o with status %s', async (verdict, status) => {
    const detail = `# Daily check-in: example.com\n\n${verdict.severity}. Coverage ${verdict.coverage}.`
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'daily-checkin')
      const dailyId = 'wolfstar-project/example:daily-checkin'
      const calls: Calls = { issues: [], comments: [] }
      const controller = createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
      for (const scheduledFor of ['2026-08-27T07:00:00.000Z', '2026-08-27T08:00:00.000Z', '2026-08-28T07:00:00.000Z']) {
        store.openRoutineRun({ routineId: dailyId, scheduledFor, specSha: 'abc123', at: scheduledFor })
        store.stageRoutineReport({
          command: routineReportCommand({
            repository: 'wolfstar-project/example',
            routineId: dailyId,
            routineName: 'daily-checkin',
            run: { id: `${dailyId}:${scheduledFor}`, scheduledFor },
            report: { _tag: 'Completed', evidence: '0 new Candidates', detail, verdict },
          }),
          at: now().toISOString(),
        })
        settleRun(store, `${dailyId}:${scheduledFor}`)
        await controller.publishPending(new AbortController().signal)
      }
      expect(calls.issues).toEqual([`[${status}] Daily check-in: wolfstar-project/example`])
      expect(calls.comments).toHaveLength(1)
      expect(calls.updates).toHaveLength(3)
      expect(calls.updates?.at(-1)?.body).toContain('2026-08-28')
      expect(calls.updates?.at(-1)?.body).toContain(detail)
    } finally {
      store.close()
    }
  })

  it.each([
    ['a heading before the verdict', '# Daily Check-in: unhead.unjs.io\n\nVerdict: GREEN. Both external checks pass.'],
    [
      'a verdict line that denies incomplete coverage',
      'Verdict: GREEN. All three required checks passed. No incomplete coverage.',
    ],
  ])('reads CLEAR from the stated verdict when the report prose has %s', async (_case, detail) => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'daily-checkin')
      const dailyId = 'wolfstar-project/example:daily-checkin'
      const scheduledFor = '2026-08-27T07:00:00.000Z'
      const calls: Calls = { issues: [], comments: [] }
      const controller = createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
      store.stageRoutineReport({
        command: routineReportCommand({
          repository: 'wolfstar-project/example',
          routineId: dailyId,
          routineName: 'daily-checkin',
          run: { id: `${dailyId}:${scheduledFor}`, scheduledFor },
          report: {
            _tag: 'Completed',
            evidence: '0 new Candidates',
            detail,
            verdict: { severity: 'GREEN', coverage: 'complete' },
          },
        }),
        at: now().toISOString(),
      })
      settleRun(store, `${dailyId}:${scheduledFor}`)
      await controller.publishPending(new AbortController().signal)

      expect(calls.issues).toEqual(['[CLEAR] Daily check-in: wolfstar-project/example'])
    } finally {
      store.close()
    }
  })

  it('blocks the daily issue when the run states no verdict', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'daily-checkin')
      const dailyId = 'wolfstar-project/example:daily-checkin'
      const scheduledFor = '2026-08-27T07:00:00.000Z'
      const calls: Calls = { issues: [], comments: [] }
      const controller = createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
      store.stageRoutineReport({
        command: routineReportCommand({
          repository: 'wolfstar-project/example',
          routineId: dailyId,
          routineName: 'daily-checkin',
          run: { id: `${dailyId}:${scheduledFor}`, scheduledFor },
          report: { _tag: 'Completed', evidence: '0 new Candidates', detail: 'GREEN. Everything passed.' },
        }),
        at: now().toISOString(),
      })
      settleRun(store, `${dailyId}:${scheduledFor}`)
      await controller.publishPending(new AbortController().signal)

      expect(calls.issues).toEqual(['[BLOCKED] Daily check-in: wolfstar-project/example'])
    } finally {
      store.close()
    }
  })

  it('titles the daily issue with the same status its comment heading carries', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'daily-checkin')
      const dailyId = 'wolfstar-project/example:daily-checkin'
      const dailyRun = `${dailyId}:2026-08-27T07:00:00.000Z`
      store.recordCandidates({
        routineId: dailyId,
        runId: dailyRun,
        candidates: [
          {
            fingerprint: 'scripts/check.ts#probe',
            title: 'Fixture title',
            target: 'scripts/check.ts',
            claim: 'The probe reports the wrong status.',
            verification: 'pnpm vitest run test/routine-report.test.ts',
            estimatedChangedFiles: 1,
          },
        ],
        at: now().toISOString(),
      })
      store.stageRoutineReport({
        command: routineReportCommand({
          repository: 'wolfstar-project/example',
          routineId: dailyId,
          routineName: 'daily-checkin',
          run: { id: dailyRun, scheduledFor: '2026-08-27T07:00:00.000Z' },
          report: {
            _tag: 'Completed',
            evidence: '1 found',
            detail: 'GREEN. All checks passed.',
            verdict: { severity: 'GREEN', coverage: 'complete' },
          },
        }),
        at: now().toISOString(),
      })
      settleRun(store, dailyRun)
      const calls: Calls = { issues: [], comments: [] }
      await createRoutineReportController({
        github: publisher(calls),
        now,
        store,
        workerId: 'reporter',
      }).publishPending(new AbortController().signal)

      const heading = calls.updates?.at(-1)?.body.match(/^# \[([^\]]+)\] Daily check-in/m)?.[1] ?? ''
      expect(heading).toBe('ACTION NEEDED')
      expect(calls.issues[0]).toBe(`[${heading}] Daily check-in: wolfstar-project/example`)
    } finally {
      store.close()
    }
  })

  it('reads ACTION NEEDED once a retried run with Candidates settles its earlier CLEAR stage', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'daily-checkin')
      const dailyId = 'wolfstar-project/example:daily-checkin'
      const dailyRun = `${dailyId}:2026-08-27T07:00:00.000Z`
      // Attempt one scans a clear morning, stages its report, and crashes
      // before the run settles. The publication pass runs meanwhile.
      store.stageRoutineReport({
        command: routineReportCommand({
          repository: 'wolfstar-project/example',
          routineId: dailyId,
          routineName: 'daily-checkin',
          run: { id: dailyRun, scheduledFor: '2026-08-27T07:00:00.000Z' },
          report: {
            _tag: 'Completed',
            evidence: '0 found',
            detail: 'GREEN. All checks passed.',
            verdict: { severity: 'GREEN', coverage: 'complete' },
          },
        }),
        at: now().toISOString(),
      })
      const calls: Calls = { issues: [], comments: [] }
      const controller = createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
      await controller.publishPending(new AbortController().signal)
      expect(calls.issues).toEqual([])

      // The retry updates the pending report owned by the same run.
      store.recordCandidates({
        routineId: dailyId,
        runId: dailyRun,
        candidates: [
          {
            fingerprint: 'scripts/check.ts#probe',
            title: 'Fixture title',
            target: 'scripts/check.ts',
            claim: 'The probe reports the wrong status.',
            verification: 'pnpm vitest run test/routine-report.test.ts',
            estimatedChangedFiles: 1,
          },
        ],
        at: now().toISOString(),
      })
      expect(
        store.stageRoutineReport({
          command: routineReportCommand({
            repository: 'wolfstar-project/example',
            routineId: dailyId,
            routineName: 'daily-checkin',
            run: { id: dailyRun, scheduledFor: '2026-08-27T07:00:00.000Z' },
            report: {
              _tag: 'Completed',
              evidence: '1 found',
              detail: 'GREEN. All checks passed.',
              verdict: { severity: 'GREEN', coverage: 'complete' },
            },
          }),
          at: now().toISOString(),
        }),
      ).toBe(true)
      const task = store.claimNextRoutineRun('scanner', now().toISOString(), 45 * 60_000)
      if (task === null) throw new Error('Expected a queued Routine run.')
      expect(
        store.completeRoutineRun({
          taskId: task.id,
          workerId: task.state.workerId,
          fence: task.state.fence,
          at: now().toISOString(),
          evidence: '1 found',
        }),
      ).toBe(true)

      await controller.publishPending(new AbortController().signal)

      const heading = calls.updates?.at(-1)?.body.match(/^# \[([^\]]+)\] Daily check-in/m)?.[1] ?? ''
      expect(heading).toBe('ACTION NEEDED')
      expect(calls.issues[0]).toBe(`[${heading}] Daily check-in: wolfstar-project/example`)
      expect(calls.updates?.at(-1)?.body).toContain('The probe reports the wrong status.')
    } finally {
      store.close()
    }
  })
})

it('marks a skipped daily run as blocked', () => {
  const command = routineReportCommand({
    repository: 'wolfstar-project/example',
    routineId: 'wolfstar-project/example:daily-checkin',
    routineName: 'daily-checkin',
    run: {
      id: 'wolfstar-project/example:daily-checkin:2026-08-27T07:00:00.000Z',
      scheduledFor: '2026-08-27T07:00:00.000Z',
    },
    report: { _tag: 'Skipped', reason: 'The scheduled run expired.' },
  })
  expect(command.body).toContain('[BLOCKED] Daily check-in: 2026-08-27')
  expect(command.body).toContain('The scheduled run expired.')
})

it('reports terminal CI failure after a staged scan crashed', () => {
  const store = openJournalStore(':memory:')
  try {
    seed(store)
    stage(store, { _tag: 'Completed', evidence: 'Earlier scan looked clear.' })
    failRun(store, runId, 'Collection failed on every retry.')
    expect(store.claimNextRoutineReport('reporter', now().toISOString(), 60_000)?.body).toContain(
      'Failed. Collection failed on every retry.',
    )
  } finally {
    store.close()
  }
})

it('reuses the persistent issue after GitHub loses its create response', async () => {
  const store = openJournalStore(':memory:')
  try {
    seed(store, 'daily-checkin')
    const id = 'wolfstar-project/example:daily-checkin'
    const dailyRun = `${id}:2026-08-27T07:00:00.000Z`
    store.stageRoutineReport({
      command: routineReportCommand({
        repository: 'wolfstar-project/example',
        routineId: id,
        routineName: 'daily-checkin',
        run: { id: dailyRun, scheduledFor: '2026-08-27T07:00:00.000Z' },
        report: { _tag: 'Completed', evidence: 'Quiet.', verdict: { severity: 'GREEN', coverage: 'complete' } },
      }),
      at: now().toISOString(),
    })
    settleRun(store, dailyRun)
    const calls: Calls = { issues: [], comments: [] }
    const github = publisher(calls)
    const create = github.createIssue
    github.createIssue = async (input) => {
      await create(input)
      return { _tag: 'Err', error: { repository: 'wolfstar-project/example', message: 'Response lost.' } }
    }
    const controller = createRoutineReportController({ github, now, store, workerId: 'reporter' })
    expect((await controller.publishPending(new AbortController().signal, 1))[0]?._tag).toBe('Err')
    expect((await controller.publishPending(new AbortController().signal, 1))[0]?._tag).toBe('Ok')
    expect(calls.issues).toHaveLength(1)
    expect(calls.comments).toHaveLength(1)
    expect(
      isRoutineTrackingIssue({
        repository: 'wolfstar-project/example',
        title: calls.issues[0]!,
        body: calls.updates?.at(-1)?.body,
        labels: ['routine:daily-checkin'],
      }),
    ).toBe(true)
  } finally {
    store.close()
  }
})

it('publishes the latest settled daily report when an older report retries', async () => {
  const store = openJournalStore(':memory:')
  try {
    seed(store, 'daily-checkin')
    const id = 'wolfstar-project/example:daily-checkin'
    for (const date of ['2026-08-27', '2026-08-28']) {
      const scheduledFor = `${date}T07:00:00.000Z`
      store.openRoutineRun({ routineId: id, scheduledFor, specSha: 'abc123', at: scheduledFor })
      store.stageRoutineReport({
        command: routineReportCommand({
          repository: 'wolfstar-project/example',
          routineId: id,
          routineName: 'daily-checkin',
          run: { id: `${id}:${scheduledFor}`, scheduledFor },
          report: { _tag: 'Completed', evidence: date, verdict: { severity: 'GREEN', coverage: 'complete' } },
        }),
        at: scheduledFor,
      })
      settleRun(store, `${id}:${scheduledFor}`)
    }
    const report = store.claimNextRoutineReport('reporter', now().toISOString(), 60_000)
    expect(report?.runId).toContain('2026-08-27')
    expect(report?.body).toContain('2026-08-28')
    expect(store.claimNextRoutineReport('another-reporter', now().toISOString(), 60_000)).toBeNull()
  } finally {
    store.close()
  }
})
