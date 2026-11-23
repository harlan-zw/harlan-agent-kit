import type { GitHubIssuePublisher } from '../src/github.ts'
import type { RoutineRunReport, RoutineScanTally } from '../src/routine-report-controller.ts'
import type { Candidate, RoutineName } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { candidateIssueCommands } from '../src/candidate-issue-controller.ts'
import { ok } from '../src/result.ts'
import { createRoutineReportController, isRoutineTrackingIssue, parseRunLogEntry, routineReportBody, routineReportCommand, runLogEntryComment, trackingIssueBody, trackingIssueTitle } from '../src/routine-report-controller.ts'
import { getRoutine } from '../src/routines/index.ts'
import { openJournalStore } from '../src/store.ts'
import { repositoryMapping } from './fixtures.ts'

const now = () => new Date('2026-08-27T07:10:00.000Z')
const routineId = 'harlan-zw/example:pr-triage'
const runId = `${routineId}:2026-08-27T07:00:00.000Z`
const footer = '<sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) posted this automated Routine report, not Harlan. [AI policy](https://harlanzw.com/blog/ai-in-open-source).</sub>'

const quiet: RoutineScanTally = { found: 0, fresh: 0, known: 0, outsideScope: 0, oversized: null, fingerprints: [] }

function scanned(evidence: string, rest: Partial<Extract<RoutineRunReport, { _tag: 'Scanned' }>> = {}): RoutineRunReport {
  return { _tag: 'Scanned', evidence, tally: quiet, ...rest }
}

it('replaces a staged result when a retry finishes with newer evidence', () => {
  const store = openJournalStore(':memory:')
  seed(store)
  stage(store, scanned('First attempt', { detail: 'Provider was unavailable.' }))
  stage(store, scanned('Final attempt', { detail: 'The scan found no issues.' }))
  settleRun(store, runId)
  const report = store.claimNextRoutineReport('publisher', now().toISOString(), 60_000)
  expect(report?.body).toContain('Final attempt')
  expect(report?.body).not.toContain('First attempt')
  expect(report?.entry).toMatchObject({ _tag: 'Scanned', summary: 'The scan found no issues.' })
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
  expect(report?.entry).toEqual({ _tag: 'Failed', reason: 'GitHub requests reached their rate limit.' })
  store.close()
})

function seed(store: ReturnType<typeof openJournalStore>, name: RoutineName = 'pr-triage'): void {
  store.syncRepositories([repositoryMapping()], '2026-08-27T00:00:00.000Z')
  store.setRepositoryWritesEnabled('harlan-zw/example', true)
  store.syncRoutines({
    repository: 'harlan-zw/example',
    specSha: 'abc123',
    entries: [{ name, crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'propose', enabled: true }],
    at: '2026-08-27T00:00:00.000Z',
  })
  store.openRoutineRun({
    routineId: `harlan-zw/example:${name}`,
    scheduledFor: '2026-08-27T07:00:00.000Z',
    specSha: 'abc123',
    at: '2026-08-27T07:00:05.000Z',
  })
}

/** Settles a queued run the way the scheduler does, so its staged report may publish. */
function settleRun(store: ReturnType<typeof openJournalStore>, runId: string): void {
  const task = store.claimNextRoutineRun('scanner', now().toISOString(), 45 * 60_000)
  if (task === null || task.id !== runId)
    throw new Error(`Expected the queued Routine run ${runId}.`)
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
    if (task === null || task.id !== runId)
      throw new Error(`Expected the queued Routine run ${runId}.`)
    if (store.failRoutineRun({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: now().toISOString(),
      reason,
    }) === 'Failed') {
      return
    }
  }
}

function stage(store: ReturnType<typeof openJournalStore>, report: RoutineRunReport, run = { id: runId, scheduledFor: '2026-08-27T07:00:00.000Z' }): boolean {
  return store.stageRoutineReport({
    command: routineReportCommand({
      repository: 'harlan-zw/example',
      routineId,
      routineName: 'pr-triage',
      run,
      report,
    }),
    at: now().toISOString(),
  })
}

interface Calls {
  issues: string[]
  issueBodies?: string[]
  updates?: Array<{ title: string, body: string }>
  comments: Array<{ issueNumber: number, body: string }>
}

function publisher(calls: Calls, issueNumber = 42): GitHubIssuePublisher {
  let created = false
  return {
    updateIssue: async (input) => {
      (calls.updates ??= []).push({ title: input.title, body: input.body })
      return ok(undefined)
    },
    createIssue: async (input) => {
      created = true
      calls.issues.push(input.title)
      ;(calls.issueBodies ??= []).push(input.body)
      return ok({ number: issueNumber, url: `https://github.com/harlan-zw/example/issues/${issueNumber}` })
    },
    createComment: async (input) => {
      calls.comments.push({ issueNumber: input.issueNumber, body: input.body })
      return ok({ id: 900 + calls.comments.length })
    },
    findOpenIssueByFingerprint: async () => ok(null),
    findRoutineTrackingIssue: async () => ok(created ? { number: issueNumber, url: `https://github.com/harlan-zw/example/issues/${issueNumber}` } : null),
    findIssueCommentByMarker: async input => ok(calls.comments.findIndex(comment => comment.body.includes(input.marker)) < 0 ? null : { id: 901 }),
  }
}

function proposal(fingerprint: string, title: string) {
  return {
    fingerprint,
    title,
    target: 'src/store.ts',
    claim: `The claim behind ${title}.`,
    verification: 'pnpm vitest run test/routine-controller.test.ts',
    estimatedChangedFiles: 2,
  }
}

describe('the private archive of one run', () => {
  it('says what a completed run found', () => {
    const body = routineReportBody(
      { scheduledFor: '2026-08-27T07:00:00.000Z' },
      scanned('pr-triage | 0 found | 0 new'),
    )

    expect(body).toContain('2026-08-27T07:00:00.000Z')
    expect(body).toContain('0 found')
  })

  it('includes every saved result so the archive does not hide what was found', () => {
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
      scanned('pr-triage | 1 found | 1 new'),
      found,
    )

    expect(body).toContain('The scheduler can open the same run twice.')
    expect(body).toContain('src/store.ts')
    expect(body).toContain('pnpm vitest run test/routine-controller.test.ts')
  })
})

describe('the tracking issue', () => {
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

  it('keeps recognising a run log opened while skipped runs still reported', () => {
    expect(isRoutineTrackingIssue({
      repository: 'harlan-zw/example',
      title: trackingIssueTitle('sentry-checkin', 'harlan-zw/example'),
      body: 'Every run of the `sentry-checkin` routine reports here, including the runs that found nothing and the runs that were skipped.\n\nClose a proposal\'s own issue to reject it. Closing this one stops the log, not the routine.\n\n> The Harlan Agent Kit opened this issue automatically. It is not Harlan\'s own report.',
      labels: ['routine:sentry-checkin'],
    })).toBe(true)
  })
})

describe('a run log entry', () => {
  const ciReview = {
    runId: 'harlan-zw/harlan-agent-kit:ci-review:2026-11-22T23:00:00.000Z',
    routineName: 'ci-review' as const,
    scheduledFor: '2026-11-22T23:00:00.000Z',
  }

  it('writes a heading, a counts table, an owner table, and folds', () => {
    expect(runLogEntryComment({
      ...ciReview,
      entry: {
        _tag: 'Scanned',
        found: 3,
        fresh: 0,
        known: 1,
        outsideScope: 1,
        oversized: { limit: 5, count: 1 },
        fingerprints: ['pnpm-lock.yaml#transitive'],
        verdict: { severity: 'RED', coverage: 'incomplete' },
        summary: 'Vulnerable transitive dependencies remain. Six cancelled runs have no job logs.',
      },
      reported: [{ title: 'Vulnerable transitive dependencies after pending updates', result: { _tag: 'Proposed', pullRequest: null }, issue: { _tag: 'Filed', number: 752 } }],
    })).toBe([
      '<!-- routine-run: harlan-zw/harlan-agent-kit:ci-review:2026-11-22T23:00:00.000Z -->',
      '### 🟠 ci-review · Nov 22, 23:00 UTC',
      '',
      '| Found | New | Known | Coverage |',
      '| --: | --: | --: | :-- |',
      '| 3 | 0 | 1 | incomplete |',
      '',
      '| Proposal | Owner |',
      '| :-- | :-- |',
      '| Vulnerable transitive dependencies after pending updates | #752 |',
      '',
      '<details><summary>Dropped proposals</summary>',
      '',
      '- This Routine\'s rules left out 1 proposal.',
      '- 1 proposal would change more than 5 files.',
      '',
      'The run filed no issue for these proposals.',
      '',
      '</details>',
      '',
      '<details><summary>Summary</summary>',
      '',
      'Vulnerable transitive dependencies remain. Six cancelled runs have no job logs.',
      '',
      'The Dashboard History page keeps the full report.',
      '',
      '</details>',
      '',
      footer,
    ].join('\n'))
  })

  it('writes a quiet run with a white dot, its counts, and no owner table', () => {
    const body = runLogEntryComment({
      ...ciReview,
      scheduledFor: '2027-01-01T00:05:00.000Z',
      entry: { _tag: 'Scanned', ...quiet, verdict: null, summary: null },
      reported: [],
    })

    expect(body).toBe([
      '<!-- routine-run: harlan-zw/harlan-agent-kit:ci-review:2026-11-22T23:00:00.000Z -->',
      '### ⚪ ci-review · Jan 1, 00:05 UTC',
      '',
      '| Found | New | Known |',
      '| --: | --: | --: |',
      '| 0 | 0 | 0 |',
      '',
      footer,
    ].join('\n'))
  })

  it('marks a run that a person must act on even when it reports no Candidate', () => {
    const body = runLogEntryComment({
      ...ciReview,
      entry: { _tag: 'Scanned', ...quiet, verdict: { severity: 'AMBER', coverage: 'complete' }, summary: null },
      reported: [],
    })

    expect(body).toContain('### 🟠 ci-review · Nov 22, 23:00 UTC')
    expect(body).toContain('| 0 | 0 | 0 | complete |')
  })

  it('keeps a quiet verdict white when its coverage is incomplete', () => {
    const body = runLogEntryComment({
      ...ciReview,
      entry: { _tag: 'Scanned', ...quiet, verdict: { severity: 'GREEN', coverage: 'incomplete' }, summary: null },
      reported: [],
    })

    expect(body).toContain('### ⚪ ci-review')
  })

  it.each([
    [{ _tag: 'Proposed', pullRequest: null }, { _tag: 'Requested' }, 'issue queued'],
    [{ _tag: 'Proposed', pullRequest: null }, { _tag: 'Refused' }, 'filing failed'],
    [{ _tag: 'Proposed', pullRequest: null }, { _tag: 'NotRequested' }, 'no issue'],
    [{ _tag: 'Proposed', pullRequest: 31 }, { _tag: 'NotRequested' }, '#31'],
    [{ _tag: 'Merged', pullRequest: 31 }, { _tag: 'NotRequested' }, '#31'],
    [{ _tag: 'Rejected', reason: 'Not a defect.' }, { _tag: 'NotRequested' }, 'rejected'],
    [{ _tag: 'Merged', pullRequest: 31 }, { _tag: 'Filed', number: 12 }, '#12'],
  ] as const)('names the owner of a %o Candidate whose issue is %o as %s', (result, issue, owner) => {
    const body = runLogEntryComment({
      ...ciReview,
      entry: { _tag: 'Scanned', ...quiet, found: 1, known: 1, fingerprints: ['a'], verdict: null, summary: null },
      reported: [{ title: 'A defect', result, issue }],
    })

    expect(body).toContain(`| A defect | ${owner} |`)
  })

  it('keeps Agent text from linking, notifying, or splitting a cell', () => {
    const body = runLogEntryComment({
      ...ciReview,
      entry: { _tag: 'Failed', reason: 'Registry 503 | see #12 and harlan-zw/example#3 from @octocat, mail a@b.dev, keep `#4`' },
      reported: [],
    })

    expect(body).toBe([
      '<!-- routine-run: harlan-zw/harlan-agent-kit:ci-review:2026-11-22T23:00:00.000Z -->',
      '### 🟠 ci-review · failed',
      '',
      '| Run | Cause | Next |',
      '| :-- | :-- | :-- |',
      '| Nov 22, 23:00 UTC | Registry 503 \\| see `#12` and `harlan-zw/example#3` from `@octocat`, mail a@b.dev, keep `#4` | next scheduled run |',
      '',
      footer,
    ].join('\n'))
  })

  it('heads the ready digest with a dot only when a pull request waits', () => {
    const waiting = runLogEntryComment({ ...ciReview, routineName: 'ready-digest', entry: { _tag: 'ReadyDigest', total: 1, list: '1 pull request is READY with passing CI, oldest first.\n\n- `harlan-zw/example#4`: 2 days since READY' }, reported: [] })
    const none = runLogEntryComment({ ...ciReview, routineName: 'ready-digest', entry: { _tag: 'ReadyDigest', total: 0, list: 'No pull request is READY with passing CI.' }, reported: [] })

    expect(waiting).toContain('### 🟠 ready-digest · Nov 22, 23:00 UTC\n\n1 pull request is READY with passing CI, oldest first.\n\n- `harlan-zw/example#4`: 2 days since READY\n\n<sub>')
    expect(none).toContain('### ⚪ ready-digest · Nov 22, 23:00 UTC\n\nNo pull request is READY with passing CI.')
  })
})

describe('the summary a run log entry folds', () => {
  const summaryOf = (detail: string) => {
    const { entry } = routineReportCommand({ repository: 'harlan-zw/example', routineId, routineName: 'pr-triage', run: { id: runId, scheduledFor: '2026-08-27T07:00:00.000Z' }, report: scanned('evidence', { detail }) })
    return entry._tag === 'Scanned' ? entry.summary : undefined
  }

  it('keeps the opening prose and drops local paths, hosts, and everything after the first heading', () => {
    const detail = [
      'Coverage: **incomplete**.',
      '',
      '**One urgent Candidate.** Vulnerable dependencies remain.',
      '[Full report and evidence index](https://notes.localhost/notes/ci-review-2026-11-22).',
      'Evidence directory: `~/scratch/ci-review-2026-11-22/`.',
      '',
      '### Scope',
      '',
      'Selected 98 of 241 runs.',
      '',
      'x'.repeat(15_000),
    ].join('\n')

    expect(summaryOf(detail)).toBe('Coverage: **incomplete**.\n\n**One urgent Candidate.** Vulnerable dependencies remain.')
  })

  it('folds no summary when the opening paragraph is too long to keep whole', () => {
    expect(summaryOf(`${'A long sentence. '.repeat(50)}\n\nShort.`)).toBeNull()
    expect(summaryOf('')).toBeNull()
    expect(summaryOf('| Run | Result |\n| :-- | :-- |\n| 1 | ok |')).toBeNull()
  })

  it('cannot close the fold it sits in', () => {
    expect(summaryOf('Done.</details> Nothing else.')).toBe('Done. Nothing else.')
  })

  it.each([
    ['Checked <!-- private-fixture --> every workflow.', 'Checked  every workflow.'],
    ['**Checked <!-- private-fixture --> every workflow.**', '**Checked  every workflow.**'],
    ['[Checked <!-- private-fixture --> every workflow.](https://github.com)', '[Checked  every workflow.](https://github.com)'],
    ['The literal `<!--` is code.\n\nSecond public paragraph.\n\n## Evidence\n\n<!-- private-fixture -->', 'The literal ` ` is code.\n\nSecond public paragraph.'],
  ])('removes only parsed comments before cleaning public prose: %s', (detail, expected) => {
    expect(summaryOf(detail)).toBe(expected)
  })

  it.each([
    ['a fence with a blank line inside', '```text\nprivate-fixture line\n\nprivate-fixture after the blank line\n```'],
  ])('keeps %s out of the summary', (_case, opening) => {
    expect(summaryOf(`${opening}\n\nThe run checked every workflow.`)).toBe('The run checked every workflow.')
  })

  it.each([
    '<!--\n\nprivate-fixture note\n\n-->',
    '<details>\n<summary>Logs</summary>\n\nprivate-fixture\n\n</details>',
    '<div>private-fixture</div>',
  ])('ends the summary at an HTML block: %s', (block) => {
    expect(summaryOf(`${block}\n\nLater prose.`)).toBeNull()
    expect(summaryOf(`Public opening.\n\n${block}\n\nLater prose.`)).toBe('Public opening.')
  })

  it('keeps a fence left open out of the summary', () => {
    expect(summaryOf('~~~\nprivate-fixture\n\nprivate-fixture again\n\nThe run checked every workflow.')).toBeNull()
  })

  it('stops at code that follows the opening prose', () => {
    expect(summaryOf('The run checked every workflow.\n\n    private-fixture\n\nLater prose.')).toBe('The run checked every workflow.')
  })

  it('counts paragraph breaks toward the limit', () => {
    const paragraph = `${'Word '.repeat(59)}ends.`

    expect(paragraph).toHaveLength(300)
    expect(summaryOf(`${paragraph}\n\n${paragraph}`)).toBe(paragraph)
    expect(summaryOf(`${paragraph}\n\n${paragraph.slice(2)}`)).toHaveLength(600)
  })

  it.each([
    ['a filesystem path', 'The agent wrote logs to /var/log/agent/run.log.'],
    ['a home path', 'Evidence sits in $HOME/scratch/run.'],
    ['a Windows path', 'Evidence sits in C:\\Users\\agent\\run.'],
    ['a tailnet host', 'Open https://hogwild.tail1234.ts.net/history for detail.'],
    ['a single-label host', 'The Service at http://hogwild:3210/api answered.'],
    ['a private address', 'The probe hit 10.0.4.7 and timed out.'],
    ['a local host name', 'The site at preview.local failed.'],
  ])('drops a line that names %s', (_case, line) => {
    expect(summaryOf(`${line}\nThe run checked every workflow.`)).toBe('The run checked every workflow.')
  })

  it('keeps public links and repository paths', () => {
    const line = 'See https://github.com/harlan-zw/example/issues/4 and src/store.ts, per nuxt.com docs.'

    expect(summaryOf(line)).toBe(line)
  })
})

describe('configured private hosts', () => {
  it('drops a summary line that names a configured host, with or without a link', () => {
    const body = runLogEntryComment({
      runId,
      routineName: 'pr-triage',
      scheduledFor: '2026-08-27T07:00:00.000Z',
      entry: { _tag: 'Scanned', ...quiet, verdict: null, summary: 'Open https://agent.example.org/history for detail.\nagent.example.org restarted twice.\nThe run checked every workflow.' },
      reported: [],
      privateHosts: ['agent.example.org'],
    })

    expect(body).toContain('<details><summary>Summary</summary>\n\nThe run checked every workflow.\n\nThe Dashboard')
    expect(body).not.toContain('agent.example.org')
  })

  it('folds no summary when every line names a private host', () => {
    const body = runLogEntryComment({
      runId,
      routineName: 'pr-triage',
      scheduledFor: '2026-08-27T07:00:00.000Z',
      entry: { _tag: 'Scanned', ...quiet, verdict: null, summary: 'agent.example.org restarted twice.' },
      reported: [],
      privateHosts: ['agent.example.org'],
    })

    expect(body).not.toContain('<summary>Summary</summary>')
  })

  it('reaches the comment through the controller', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, scanned('evidence', { detail: 'Open https://agent.example.org/history.\nThe run checked every workflow.' }))
      settleRun(store, runId)
      const calls: Calls = { issues: [], comments: [] }

      await createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter', privateHosts: ['agent.example.org'] })
        .publishPending(new AbortController().signal)

      expect(calls.comments[0]?.body).toContain('The run checked every workflow.')
      expect(calls.comments[0]?.body).not.toContain('agent.example.org')
    }
    finally {
      store.close()
    }
  })
})

it.each([
  ['an inline comment marker', 'The literal `<!--` is code.\n\n## Evidence\n\n<!-- ordinary comment -->\n\nprivate-fixture paragraph.', 'is code.'],
  ['a leading thematic break', '---\n\nprivate-fixture paragraph.', null],
  ['a quote after redacted prose', 'Evidence: /var/log/agent/run.log\n\n> quoted evidence\n\nprivate-fixture paragraph.', null],
  ['a fence after redacted prose', 'Evidence: /var/log/agent/run.log\n\n```text\nlogs\n```\n\nprivate-fixture paragraph.', null],
  ['HTML after redacted prose', 'Evidence: /var/log/agent/run.log\n\n<div>logs</div>\n\nprivate-fixture paragraph.', null],
] as const)('keeps evidence behind %s in the archive across scan parsers and public consumers', async (_name, report, summary) => {
  for (const name of ['pr-triage', 'dependency-updates', 'vitals-review'] as const) {
    const parsed = getRoutine(name).parseResponse({ report, candidates: [], outcome: 'complete', updates: [], fieldFindings: [], labFindings: [] })
    if (parsed._tag === 'Err')
      throw new Error(parsed.error)
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, scanned('evidence', { detail: parsed.value.report }))
      settleRun(store, runId)
      const calls: Calls = { issues: [], comments: [] }

      await createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
        .publishPending(new AbortController().signal)

      expect(calls.comments).toHaveLength(1)
      expect(calls.comments[0]?.body).not.toContain('private-fixture')
      if (summary === null)
        expect(calls.comments[0]?.body).not.toContain('<summary>Summary</summary>')
      else
        expect(calls.comments[0]?.body).toContain(summary)
      expect(store.getDashboardSnapshot(now().toISOString()).routineRuns[0]?.report?.body).toContain(report)
    }
    finally {
      store.close()
    }
  }
})

it.each([
  ['nested folds', '<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\nInner evidence.\n\n</details>\n\nprivate-fixture between closing tags.\n\n</details>'],
  ['mixed nested elements', '<div>\n\n<details>\n\nInner evidence.\n\n</details>\n\nprivate-fixture between closing tags.\n\n</div>'],
  ['nested folds in one HTML token', '<details><details>Inner evidence.</details>\n\nprivate-fixture between closing tags.\n\n</details>'],
  ['an unclosed outer fold', '<details>\n\n<details>\n\nInner evidence.\n\n</details>\n\nprivate-fixture after the inner fold.'],
])('keeps %s private across scan parsers, stored entries, and public consumers', async (_name, report) => {
  for (const name of ['pr-triage', 'dependency-updates', 'vitals-review'] as const) {
    const parsed = getRoutine(name).parseResponse({ report, candidates: [], outcome: 'complete', updates: [], fieldFindings: [], labFindings: [] })
    if (parsed._tag === 'Err')
      throw new Error(parsed.error)
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, scanned('evidence', { detail: parsed.value.report }))
      settleRun(store, runId)
      const calls: Calls = { issues: [], comments: [] }

      await createRoutineReportController({
        github: publisher(calls),
        now,
        store: {
          ...store,
          claimNextRoutineReport: (...args) => {
            const command = store.claimNextRoutineReport(...args)
            if (command !== null) {
              expect(command.entry).toMatchObject({ _tag: 'Scanned', summary: null })
              if (command.entry !== null)
                expect(runLogEntryComment({ ...command, entry: command.entry })).not.toContain('private-fixture')
            }
            return command
          },
        },
        workerId: 'reporter',
      }).publishPending(new AbortController().signal)

      expect(calls.comments).toHaveLength(1)
      for (const body of [...calls.issues, ...(calls.issueBodies ?? []), ...(calls.updates ?? []).map(update => update.body), ...calls.comments.map(comment => comment.body)])
        expect(body).not.toContain('private-fixture')
      expect(store.getDashboardSnapshot(now().toISOString()).routineRuns[0]?.report?.body).toContain(report)
    }
    finally {
      store.close()
    }
  }
})

it.each(['pr-triage', 'dependency-updates', 'vitals-review'] as const)('keeps opening indented evidence private through the %s scan parser and publisher', async (name) => {
  const report = '    private-fixture first line\n    private-fixture second line\n\nThe run checked every workflow.'
  const parsed = getRoutine(name).parseResponse({ report, candidates: [], outcome: 'complete', updates: [], fieldFindings: [], labFindings: [] })
  if (parsed._tag === 'Err')
    throw new Error(parsed.error)
  const store = openJournalStore(':memory:')
  try {
    seed(store)
    stage(store, scanned('evidence', { detail: parsed.value.report }))
    settleRun(store, runId)
    const calls: Calls = { issues: [], comments: [] }

    await createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
      .publishPending(new AbortController().signal)

    expect(calls.comments[0]?.body).toContain('<details><summary>Summary</summary>\n\nThe run checked every workflow.\n\n')
    expect(calls.comments[0]?.body).not.toContain('private-fixture')
    expect(store.getDashboardSnapshot(now().toISOString()).routineRuns[0]?.report?.body).toContain(report)
  }
  finally {
    store.close()
  }
})

it.each([
  '# Evidence',
  '## Evidence',
  'Evidence\n========',
  '- Evidence',
  '| Evidence |\n| --- |\n| fixture |',
])('keeps prose after the opening section boundary %s in the archive only', async (opening) => {
  const report = `${opening}\n\nprivate-fixture paragraph.`
  const store = openJournalStore(':memory:')
  try {
    seed(store)
    stage(store, scanned('evidence', { detail: report }))
    settleRun(store, runId)
    const calls: Calls = { issues: [], comments: [] }

    await createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
      .publishPending(new AbortController().signal)

    expect(calls.comments).toHaveLength(1)
    expect(calls.comments[0]?.body).not.toContain('private-fixture')
    expect(calls.comments[0]?.body).not.toContain('<summary>Summary</summary>')
    expect(store.getDashboardSnapshot(now().toISOString()).routineRuns[0]?.report?.body).toContain(report)
  }
  finally {
    store.close()
  }
})

it('publishes only the prose after an opening fence and keeps the fence in the archive', async () => {
  const store = openJournalStore(':memory:')
  try {
    seed(store)
    stage(store, scanned('evidence', { detail: '```text\nprivate-fixture line\n\nprivate-fixture after the blank line\n```\n\nThe run checked every workflow.' }))
    settleRun(store, runId)
    const calls: Calls = { issues: [], comments: [] }

    await createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
      .publishPending(new AbortController().signal)

    expect(calls.comments[0]?.body).toContain('<details><summary>Summary</summary>\n\nThe run checked every workflow.\n\n')
    expect(calls.comments[0]?.body).not.toContain('private-fixture')
    expect(store.getDashboardSnapshot(now().toISOString()).routineRuns[0]?.report?.body).toContain('private-fixture after the blank line')
  }
  finally {
    store.close()
  }
})

describe('stored run log entries', () => {
  it('reads every staged run log entry back unchanged', () => {
    const reports: RoutineRunReport[] = [
      scanned('evidence', { tally: { found: 2, fresh: 1, known: 1, outsideScope: 0, oversized: { limit: 5, count: 0 }, fingerprints: ['a', 'b', 'a'] }, detail: 'Two found.', verdict: { severity: 'AMBER', coverage: 'complete' } }),
      { _tag: 'ReadyDigest', evidence: 'ready-digest | 0', total: 0, list: 'No pull request is READY with passing CI.' },
      { _tag: 'Failed', reason: 'Collection failed.' },
    ]
    for (const report of reports) {
      const { entry } = routineReportCommand({ repository: 'harlan-zw/example', routineId, routineName: 'pr-triage', run: { id: runId, scheduledFor: '2026-08-27T07:00:00.000Z' }, report })
      expect(parseRunLogEntry(JSON.stringify(entry))).toEqual(entry)
    }
  })

  it('refuses a stored shape this version does not know', () => {
    expect(parseRunLogEntry(null)).toBeNull()
    expect(parseRunLogEntry('{"_tag":"Skipped","reason":"late"}')).toBeNull()
    expect(parseRunLogEntry('{"_tag":"Scanned","found":-1}')).toBeNull()
  })
})

describe('publishing the run log', () => {
  it.each([
    ['quoted fence', '> ```text\n> PRIVATE_EVIDENCE_FIXTURE\n> ```'],
    ['nested quoted fence', '> > ~~~text\n> > PRIVATE_EVIDENCE_FIXTURE\n> > ~~~'],
    ['adjacent heading', '## Evidence\nPRIVATE_EVIDENCE_FIXTURE'],
    ['adjacent fence', '```text\nPRIVATE_EVIDENCE_FIXTURE\n```'],
    ['adjacent list', '- PRIVATE_EVIDENCE_FIXTURE'],
    ['adjacent HTML', '<div>\nPRIVATE_EVIDENCE_FIXTURE\n</div>'],
  ])('keeps opening prose public and %s evidence only in the archive', async (_name, evidence) => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, scanned('pr-triage | 0 found', { detail: `The scan found no issues.\n${evidence}` }))
      settleRun(store, runId)
      const calls: Calls = { issues: [], comments: [] }
      const results = await createRoutineReportController({
        github: publisher(calls),
        now,
        store: {
          ...store,
          claimNextRoutineReport: (...args) => {
            const command = store.claimNextRoutineReport(...args)
            if (command !== null)
              expect(command.body).toContain(evidence)
            return command
          },
        },
        workerId: 'reporter',
      }).publishPending(new AbortController().signal)

      expect(results).toEqual([{ _tag: 'Ok', value: { repository: 'harlan-zw/example', issueNumber: 42 } }])
      expect(calls.comments).toHaveLength(1)
      expect(calls.comments[0]?.body).toContain('The scan found no issues.')
      for (const body of [...calls.issues, ...(calls.issueBodies ?? []), ...(calls.updates ?? []).map(update => update.body), ...calls.comments.map(comment => comment.body)]) {
        expect(body).not.toContain('PRIVATE_EVIDENCE_FIXTURE')
        expect(body).not.toContain('## Evidence')
      }
    }
    finally {
      store.close()
    }
  })

  it.each([
    ['backticks', '```text\nPrivate fixture header.\n\nPRIVATE_REPORT_FIXTURE\n```', 'The scan found no issues.'],
    ['tildes', '~~~text\nPrivate fixture header.\n\nPRIVATE_REPORT_FIXTURE\n~~~', 'The scan found no issues.'],
    ['longer fence', '````text\n\n```\n\nPRIVATE_REPORT_FIXTURE\n````', 'The scan found no issues.'],
    ['different marker', '```text\n\n~~~\n\nPRIVATE_REPORT_FIXTURE\n```', 'The scan found no issues.'],
    ['unclosed fence', '```text\nPrivate fixture header.\n\nPRIVATE_REPORT_FIXTURE', null],
    ['adjacent prose', '```text\nPrivate fixture header.\n\nPRIVATE_REPORT_FIXTURE\n```', 'The scan found no issues.', '\n'],
  ])('keeps %s fenced report content private when publishing a scanned report', async (_name, block, summary, separator = '\n\n') => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, scanned('pr-triage | 0 found', { detail: `${block}${separator}The scan found no issues.` }))
      settleRun(store, runId)
      const calls: Calls = { issues: [], comments: [] }
      const results = await createRoutineReportController({
        github: publisher(calls),
        now,
        store: {
          ...store,
          claimNextRoutineReport: (...args) => {
            const command = store.claimNextRoutineReport(...args)
            if (command !== null) {
              expect(command.body).toContain(block)
              expect(command.entry).toMatchObject({ _tag: 'Scanned', summary })
            }
            return command
          },
        },
        workerId: 'reporter',
      }).publishPending(new AbortController().signal)

      expect(results).toEqual([{ _tag: 'Ok', value: { repository: 'harlan-zw/example', issueNumber: 42 } }])
      expect(calls.comments.map(comment => comment.body)).toEqual([[
        `<!-- routine-run: ${runId} -->`,
        '### ⚪ pr-triage · Aug 27, 07:00 UTC',
        '',
        '| Found | New | Known |',
        '| --: | --: | --: |',
        '| 0 | 0 | 0 |',
        ...(summary === null ? [] : ['', '<details><summary>Summary</summary>', '', summary, '', 'The Dashboard History page keeps the full report.', '', '</details>']),
        '',
        footer,
      ].join('\n')])
    }
    finally {
      store.close()
    }
  })

  it('opens the tracking issue on the first run and writes a run log entry, not the report', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      store.recordCandidates({ routineId, runId, candidates: [proposal('src/store.ts#openRoutineRun', 'Fixture title')], at: now().toISOString() })
      stage(store, scanned('pr-triage | 1 found', {
        tally: { found: 1, fresh: 1, known: 0, outsideScope: 0, oversized: { limit: 5, count: 0 }, fingerprints: ['src/store.ts#openRoutineRun'] },
        detail: `The scheduler can open one run twice.\n\n## Evidence\n\n${'x'.repeat(15_000)}`,
      }))
      settleRun(store, runId)
      const calls: Calls = { issues: [], comments: [] }

      const results = await createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
        .publishPending(new AbortController().signal)

      expect(results).toEqual([{ _tag: 'Ok', value: { repository: 'harlan-zw/example', issueNumber: 42 } }])
      expect(calls.issues).toEqual(['pr-triage: run log for harlan-zw/example'])
      expect(calls.comments[0]?.body).toBe([
        `<!-- routine-run: ${runId} -->`,
        '### 🟠 pr-triage · Aug 27, 07:00 UTC',
        '',
        '| Found | New | Known |',
        '| --: | --: | --: |',
        '| 1 | 1 | 0 |',
        '',
        '| Proposal | Owner |',
        '| :-- | :-- |',
        '| Fixture title | no issue |',
        '',
        '<details><summary>Summary</summary>',
        '',
        'The scheduler can open one run twice.',
        '',
        'The Dashboard History page keeps the full report.',
        '',
        '</details>',
        '',
        footer,
      ].join('\n'))
    }
    finally {
      store.close()
    }
  })

  it('names the issue that owns each new and known Candidate', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const context = { repository: 'harlan-zw/example', name: 'pr-triage' as const, scheduledFor: '2026-08-27T07:00:00.000Z' }
      const first = store.recordCandidates({ routineId, runId, candidates: [proposal('src/a.ts#known', 'Known defect')], at: now().toISOString() })
      store.stageCandidateIssues({ commands: candidateIssueCommands(first, context), at: now().toISOString() })
      const filing = store.claimNextCandidateIssue('filer', now().toISOString(), 60_000)
      if (filing === null)
        throw new Error('Expected a Candidate issue command.')
      store.completeCandidateIssue({ commandId: filing.id, workerId: filing.workerId, fence: filing.fence, at: now().toISOString(), issueNumber: 77, url: 'https://github.com/harlan-zw/example/issues/77' })
      stage(store, scanned('first run', { tally: { ...quiet, found: 1, fresh: 1, fingerprints: ['src/a.ts#known'] } }))
      settleRun(store, runId)
      const calls: Calls = { issues: [], comments: [] }
      const controller = createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
      await controller.publishPending(new AbortController().signal)

      const secondRun = `${routineId}:2026-08-28T07:00:00.000Z`
      store.openRoutineRun({ routineId, scheduledFor: '2026-08-28T07:00:00.000Z', specSha: 'abc123', at: '2026-08-28T07:00:05.000Z' })
      const second = store.recordCandidates({ routineId, runId: secondRun, candidates: [proposal('src/a.ts#known', 'Known defect'), proposal('src/b.ts#new', 'New | defect for @octocat')], at: now().toISOString() })
      store.stageCandidateIssues({ commands: candidateIssueCommands(second, { ...context, scheduledFor: '2026-08-28T07:00:00.000Z' }), at: now().toISOString() })
      stage(store, scanned('second run', { tally: { ...quiet, found: 2, fresh: 1, known: 1, fingerprints: ['src/a.ts#known', 'src/b.ts#new'] } }), { id: secondRun, scheduledFor: '2026-08-28T07:00:00.000Z' })
      settleRun(store, secondRun)
      await controller.publishPending(new AbortController().signal)

      expect(calls.comments[1]?.body).toContain([
        '| Found | New | Known |',
        '| --: | --: | --: |',
        '| 2 | 1 | 1 |',
        '',
        '| Proposal | Owner |',
        '| :-- | :-- |',
        '| Known defect | #77 |',
        '| New \\| defect for `@octocat` | issue queued |',
      ].join('\n'))
    }
    finally {
      store.close()
    }
  })

  it('never publishes a claim in place of a missing title', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      store.recordCandidates({
        routineId,
        runId,
        candidates: [
          { ...proposal('src/a.ts#blank', ''), claim: 'Private claim A names a report-mode defect.' },
          { ...proposal('src/b.ts#fallback', 'Private claim B names a report-mode defect.'), claim: 'Private claim B names a report-mode defect.' },
        ],
        at: now().toISOString(),
      })
      stage(store, scanned('evidence', { tally: { ...quiet, found: 2, fresh: 2, fingerprints: ['src/a.ts#blank', 'src/b.ts#fallback'] } }))
      settleRun(store, runId)
      const calls: Calls = { issues: [], comments: [] }

      await createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
        .publishPending(new AbortController().signal)

      expect(calls.comments[0]?.body).toContain('| Untitled proposal | no issue |\n| Untitled proposal | no issue |')
      expect(calls.comments[0]?.body).not.toContain('Private claim')
    }
    finally {
      store.close()
    }
  })

  it('writes a failed run as a run log entry with its cause', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      failRun(store, runId, 'Collection failed on every retry.')
      const calls: Calls = { issues: [], comments: [] }

      await createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
        .publishPending(new AbortController().signal)

      expect(calls.comments[0]?.body).toContain('### 🟠 pr-triage · failed\n\n| Run | Cause | Next |\n| :-- | :-- | :-- |\n| Aug 27, 07:00 UTC | Collection failed on every retry. | next scheduled run |')
    }
    finally {
      store.close()
    }
  })

  it('reuses the tracking issue on the next run', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, scanned('first run'))
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
      stage(store, scanned('second run'), { id: `${routineId}:2026-08-28T07:00:00.000Z`, scheduledFor: '2026-08-28T07:00:00.000Z' })
      settleRun(store, `${routineId}:2026-08-28T07:00:00.000Z`)
      await controller.publishPending(new AbortController().signal)

      expect(calls.issues).toHaveLength(1)
      expect(calls.comments).toHaveLength(2)
      expect(calls.comments.every(comment => comment.issueNumber === 42)).toBe(true)
    }
    finally {
      store.close()
    }
  })

  it('does not restage identical evidence', () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)

      expect(stage(store, scanned('first'))).toBe(true)
      expect(stage(store, scanned('first'))).toBe(false)
    }
    finally {
      store.close()
    }
  })

  it('restages a retry whose counts changed', () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)

      expect(stage(store, scanned('same evidence'))).toBe(true)
      expect(stage(store, scanned('same evidence', { tally: { ...quiet, found: 1, outsideScope: 1 } }))).toBe(true)
      settleRun(store, runId)
      expect(store.claimNextRoutineReport('reporter', now().toISOString(), 60_000)?.entry).toMatchObject({ found: 1, outsideScope: 1 })
    }
    finally {
      store.close()
    }
  })

  it('tries a failed report once per pass and remembers no tracking issue', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, scanned('first run'))
      settleRun(store, runId)
      const refusing: GitHubIssuePublisher = {
        createIssue: async () => ok({ number: 42, url: 'https://github.com/harlan-zw/example/issues/42' }),
        createComment: async () => ({ _tag: 'Err' as const, error: { repository: 'harlan-zw/example', message: 'GitHub returned 502.' } }),
        updateIssue: async () => ok(undefined),
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

  it('leaves a report queued while GitHub holds a quota', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, scanned('first run'))
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
        { _tag: 'Ok', value: { repository: 'harlan-zw/example', issueNumber: 42 } },
      ])
    }
    finally {
      store.close()
    }
  })

  it('adopts unknown issue and comment writes without creating duplicates', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      stage(store, scanned('first run'))
      settleRun(store, runId)
      let issue: { number: number, url: string } | null = null
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
      stage(store, scanned('first run'))
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
          report: scanned('second run'),
        }),
        at: '2026-08-27T07:10:04.000Z',
      })
      settleRun(store, runId)
      settleRun(store, workingRun.id)
      const comments: Calls['comments'] = []
      const github: GitHubIssuePublisher = {
        createIssue: async input => input.repository.github === 'harlan-zw/example'
          ? { _tag: 'Err' as const, error: { repository: input.repository.github, message: 'Issues are disabled.' } }
          : ok({ number: 42, url: 'https://github.com/harlan-zw/working/issues/42' }),
        createComment: async (input) => {
          comments.push({ issueNumber: input.issueNumber, body: input.body })
          return ok({ id: 900 + comments.length })
        },
        updateIssue: async () => ok(undefined),
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
      stage(store, scanned('first run'))
      settleRun(store, runId)
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
      stage(store, scanned('first run'))
      settleRun(store, runId)
      expect(store.claimNextRoutineReport('reporter', now().toISOString(), 60_000)).not.toBeNull()
      store.pauseAgents(now().toISOString())

      expect(store.getDashboardSnapshot(now().toISOString()).agentControl).toMatchObject({ safeToRestart: false })
    }
    finally {
      store.close()
    }
  })

  it('publishes a report staged before the upgrade as its archive body', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'harlan-agent-entry-'))
    const path = join(directory, 'state.sqlite')
    try {
      const before = openJournalStore(path)
      seed(before)
      stage(before, scanned('pr-triage | 0 found', { detail: 'The old report.' }))
      settleRun(before, runId)
      before.close()
      const legacy = new DatabaseSync(path)
      legacy.exec('ALTER TABLE routine_report_commands DROP COLUMN entry_json; PRAGMA user_version = 107;')
      legacy.close()

      const store = openJournalStore(path)
      try {
        const calls: Calls = { issues: [], comments: [] }
        await createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
          .publishPending(new AbortController().signal)

        expect(calls.comments[0]?.body).toBe(`<!-- routine-run: ${runId} -->\n**2026-08-27T07:00:00.000Z** — pr-triage | 0 found\n\nThe old report.`)
      }
      finally {
        store.close()
      }
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
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
      const dailyId = 'harlan-zw/example:daily-checkin'
      const calls: Calls = { issues: [], comments: [] }
      const controller = createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
      for (const scheduledFor of ['2026-08-27T07:00:00.000Z', '2026-08-27T08:00:00.000Z', '2026-08-28T07:00:00.000Z']) {
        store.openRoutineRun({ routineId: dailyId, scheduledFor, specSha: 'abc123', at: scheduledFor })
        store.stageRoutineReport({
          command: routineReportCommand({
            repository: 'harlan-zw/example',
            routineId: dailyId,
            routineName: 'daily-checkin',
            run: { id: `${dailyId}:${scheduledFor}`, scheduledFor },
            report: scanned('0 new Candidates', { detail, verdict }),
          }),
          at: now().toISOString(),
        })
        settleRun(store, `${dailyId}:${scheduledFor}`)
        await controller.publishPending(new AbortController().signal)
      }
      expect(calls.issues).toEqual([`[${status}] Daily check-in: harlan-zw/example`])
      expect(calls.comments).toHaveLength(1)
      expect(calls.updates).toHaveLength(3)
      expect(calls.updates?.at(-1)?.body).toContain('2026-08-28')
      expect(calls.updates?.at(-1)?.body).toContain(detail)
    }
    finally {
      store.close()
    }
  })

  it.each([
    ['a heading before the verdict', '# Daily Check-in: unhead.unjs.io\n\nVerdict: GREEN. Both external checks pass.'],
    ['a verdict line that denies incomplete coverage', 'Verdict: GREEN. All three required checks passed. No incomplete coverage.'],
  ])('reads CLEAR from the stated verdict when the report prose has %s', async (_case, detail) => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'daily-checkin')
      const dailyId = 'harlan-zw/example:daily-checkin'
      const scheduledFor = '2026-08-27T07:00:00.000Z'
      const calls: Calls = { issues: [], comments: [] }
      const controller = createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
      store.stageRoutineReport({
        command: routineReportCommand({
          repository: 'harlan-zw/example',
          routineId: dailyId,
          routineName: 'daily-checkin',
          run: { id: `${dailyId}:${scheduledFor}`, scheduledFor },
          report: scanned('0 new Candidates', { detail, verdict: { severity: 'GREEN', coverage: 'complete' } }),
        }),
        at: now().toISOString(),
      })
      settleRun(store, `${dailyId}:${scheduledFor}`)
      await controller.publishPending(new AbortController().signal)

      expect(calls.issues).toEqual(['[CLEAR] Daily check-in: harlan-zw/example'])
    }
    finally {
      store.close()
    }
  })

  it('blocks the daily issue when the run states no verdict', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'daily-checkin')
      const dailyId = 'harlan-zw/example:daily-checkin'
      const scheduledFor = '2026-08-27T07:00:00.000Z'
      const calls: Calls = { issues: [], comments: [] }
      const controller = createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
      store.stageRoutineReport({
        command: routineReportCommand({
          repository: 'harlan-zw/example',
          routineId: dailyId,
          routineName: 'daily-checkin',
          run: { id: `${dailyId}:${scheduledFor}`, scheduledFor },
          report: scanned('0 new Candidates', { detail: 'GREEN. Everything passed.' }),
        }),
        at: now().toISOString(),
      })
      settleRun(store, `${dailyId}:${scheduledFor}`)
      await controller.publishPending(new AbortController().signal)

      expect(calls.issues).toEqual(['[BLOCKED] Daily check-in: harlan-zw/example'])
    }
    finally {
      store.close()
    }
  })

  it('titles the daily issue with the same status its comment heading carries', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'daily-checkin')
      const dailyId = 'harlan-zw/example:daily-checkin'
      const dailyRun = `${dailyId}:2026-08-27T07:00:00.000Z`
      store.recordCandidates({
        routineId: dailyId,
        runId: dailyRun,
        candidates: [{
          fingerprint: 'scripts/check.ts#probe',
          title: 'Fixture title',
          target: 'scripts/check.ts',
          claim: 'The probe reports the wrong status.',
          verification: 'pnpm vitest run test/routine-report.test.ts',
          estimatedChangedFiles: 1,
        }],
        at: now().toISOString(),
      })
      store.stageRoutineReport({
        command: routineReportCommand({
          repository: 'harlan-zw/example',
          routineId: dailyId,
          routineName: 'daily-checkin',
          run: { id: dailyRun, scheduledFor: '2026-08-27T07:00:00.000Z' },
          report: scanned('1 found', { detail: 'GREEN. All checks passed.', verdict: { severity: 'GREEN', coverage: 'complete' } }),
        }),
        at: now().toISOString(),
      })
      settleRun(store, dailyRun)
      const calls: Calls = { issues: [], comments: [] }
      await createRoutineReportController({ github: publisher(calls), now, store, workerId: 'reporter' })
        .publishPending(new AbortController().signal)

      const heading = calls.updates?.at(-1)?.body.match(/^# \[([^\]]+)\] Daily check-in/m)?.[1] ?? ''
      expect(heading).toBe('ACTION NEEDED')
      expect(calls.issues[0]).toBe(`[${heading}] Daily check-in: harlan-zw/example`)
    }
    finally {
      store.close()
    }
  })

  it('reads ACTION NEEDED once a retried run with Candidates settles its earlier CLEAR stage', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'daily-checkin')
      const dailyId = 'harlan-zw/example:daily-checkin'
      const dailyRun = `${dailyId}:2026-08-27T07:00:00.000Z`
      // Attempt one scans a clear morning, stages its report, and crashes
      // before the run settles. The publication pass runs meanwhile.
      store.stageRoutineReport({
        command: routineReportCommand({
          repository: 'harlan-zw/example',
          routineId: dailyId,
          routineName: 'daily-checkin',
          run: { id: dailyRun, scheduledFor: '2026-08-27T07:00:00.000Z' },
          report: scanned('0 found', { detail: 'GREEN. All checks passed.', verdict: { severity: 'GREEN', coverage: 'complete' } }),
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
        candidates: [{
          fingerprint: 'scripts/check.ts#probe',
          title: 'Fixture title',
          target: 'scripts/check.ts',
          claim: 'The probe reports the wrong status.',
          verification: 'pnpm vitest run test/routine-report.test.ts',
          estimatedChangedFiles: 1,
        }],
        at: now().toISOString(),
      })
      expect(store.stageRoutineReport({
        command: routineReportCommand({
          repository: 'harlan-zw/example',
          routineId: dailyId,
          routineName: 'daily-checkin',
          run: { id: dailyRun, scheduledFor: '2026-08-27T07:00:00.000Z' },
          report: scanned('1 found', { detail: 'GREEN. All checks passed.', verdict: { severity: 'GREEN', coverage: 'complete' } }),
        }),
        at: now().toISOString(),
      })).toBe(true)
      const task = store.claimNextRoutineRun('scanner', now().toISOString(), 45 * 60_000)
      if (task === null)
        throw new Error('Expected a queued Routine run.')
      expect(store.completeRoutineRun({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at: now().toISOString(),
        evidence: '1 found',
      })).toBe(true)

      await controller.publishPending(new AbortController().signal)

      const heading = calls.updates?.at(-1)?.body.match(/^# \[([^\]]+)\] Daily check-in/m)?.[1] ?? ''
      expect(heading).toBe('ACTION NEEDED')
      expect(calls.issues[0]).toBe(`[${heading}] Daily check-in: harlan-zw/example`)
      expect(calls.updates?.at(-1)?.body).toContain('The probe reports the wrong status.')
    }
    finally {
      store.close()
    }
  })
})

it('reports terminal CI failure after a staged scan crashed', () => {
  const store = openJournalStore(':memory:')
  try {
    seed(store)
    stage(store, scanned('Earlier scan looked clear.'))
    failRun(store, runId, 'Collection failed on every retry.')
    expect(store.claimNextRoutineReport('reporter', now().toISOString(), 60_000)?.body).toContain('Failed. Collection failed on every retry.')
  }
  finally { store.close() }
})

it('reuses the persistent issue after GitHub loses its create response', async () => {
  const store = openJournalStore(':memory:')
  try {
    seed(store, 'daily-checkin')
    const id = 'harlan-zw/example:daily-checkin'
    const dailyRun = `${id}:2026-08-27T07:00:00.000Z`
    store.stageRoutineReport({ command: routineReportCommand({ repository: 'harlan-zw/example', routineId: id, routineName: 'daily-checkin', run: { id: dailyRun, scheduledFor: '2026-08-27T07:00:00.000Z' }, report: scanned('Quiet.', { verdict: { severity: 'GREEN', coverage: 'complete' } }) }), at: now().toISOString() })
    settleRun(store, dailyRun)
    const calls: Calls = { issues: [], comments: [] }
    const github = publisher(calls)
    const create = github.createIssue
    github.createIssue = async (input) => {
      await create(input)
      return { _tag: 'Err', error: { repository: 'harlan-zw/example', message: 'Response lost.' } }
    }
    const controller = createRoutineReportController({ github, now, store, workerId: 'reporter' })
    expect((await controller.publishPending(new AbortController().signal, 1))[0]?._tag).toBe('Err')
    expect((await controller.publishPending(new AbortController().signal, 1))[0]?._tag).toBe('Ok')
    expect(calls.issues).toHaveLength(1)
    expect(calls.comments).toHaveLength(1)
    expect(isRoutineTrackingIssue({ repository: 'harlan-zw/example', title: calls.issues[0]!, body: calls.updates?.at(-1)?.body, labels: ['routine:daily-checkin'] })).toBe(true)
  }
  finally { store.close() }
})

it('publishes the latest settled daily report when an older report retries', async () => {
  const store = openJournalStore(':memory:')
  try {
    seed(store, 'daily-checkin')
    const id = 'harlan-zw/example:daily-checkin'
    for (const date of ['2026-08-27', '2026-08-28']) {
      const scheduledFor = `${date}T07:00:00.000Z`
      store.openRoutineRun({ routineId: id, scheduledFor, specSha: 'abc123', at: scheduledFor })
      store.stageRoutineReport({ command: routineReportCommand({ repository: 'harlan-zw/example', routineId: id, routineName: 'daily-checkin', run: { id: `${id}:${scheduledFor}`, scheduledFor }, report: scanned(date, { verdict: { severity: 'GREEN', coverage: 'complete' } }) }), at: scheduledFor })
      settleRun(store, `${id}:${scheduledFor}`)
    }
    const report = store.claimNextRoutineReport('reporter', now().toISOString(), 60_000)
    expect(report?.runId).toContain('2026-08-27')
    expect(report?.body).toContain('2026-08-28')
    expect(store.claimNextRoutineReport('another-reporter', now().toISOString(), 60_000)).toBeNull()
  }
  finally { store.close() }
})
