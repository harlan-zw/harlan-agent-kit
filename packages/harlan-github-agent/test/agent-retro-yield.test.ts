import type { CheckinVerdict } from '../src/routines/contract.ts'
import type { RoutineMode } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { collectAgentRetroEvidence } from '../src/agent-retro.ts'
import { candidateIssueCommands } from '../src/candidate-issue-controller.ts'
import { routineReportCommand } from '../src/routine-report-controller.ts'
import { openJournalStore } from '../src/store.ts'
import { repositoryMapping } from './fixtures.ts'

type Store = ReturnType<typeof openJournalStore>

const stores: Store[] = []
afterEach(() => {
  stores.splice(0).forEach(store => store.close())
})

const site = 'harlan-zw/nuxtseo.com'
const routineId = `${site}:daily-checkin`
const now = new Date('2026-11-23T00:00:00.000Z')
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()
const week = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5]

const amber: CheckinVerdict = { severity: 'AMBER', coverage: 'incomplete' }
const green: CheckinVerdict = { severity: 'GREEN', coverage: 'complete' }
const request = 'Controller: supply complete issue bodies and closed history.'
const blocked = `## AMBER nuxtseo.com

Sentry repairs wait on issue bodies.

**Needs you**

1. ${request}
`
const quiet = `## GREEN nuxtseo.com

Nothing new.

**Needs you**

Nothing.
`

function checkinStore(mode: RoutineMode = 'propose'): Store {
  const store = openJournalStore(':memory:')
  stores.push(store)
  store.syncRepositories([repositoryMapping({ github: site })], '2026-09-01T00:00:00.000Z')
  store.syncRoutines({
    repository: site,
    specSha: 'abc123',
    entries: [{ name: 'daily-checkin', crons: ['0 7 * * *'], timeZone: 'Australia/Melbourne', mode, enabled: true }],
    at: '2026-09-01T00:00:00.000Z',
  })
  return store
}

/** Settles one check-in as the Routine worker does: Candidates and report staged, then the run completed. */
function checkin(store: Store, scheduledFor: string, outcome: { verdict?: CheckinVerdict, report: string, candidates?: number }): void {
  store.openRoutineRun({ routineId, scheduledFor, specSha: 'abc123', at: scheduledFor })
  const run = store.claimNextRoutineRun('worker-1', scheduledFor, 3_600_000)
  if (run === null)
    throw new Error(`Expected the run at ${scheduledFor}.`)
  const found = Array.from({ length: outcome.candidates ?? 0 }, (_, index) => ({
    fingerprint: `${scheduledFor}:${index}`,
    title: 'Fix the sitemap',
    target: 'server/routes/sitemap.ts',
    claim: 'The sitemap drops localized pages.',
    verification: 'pnpm test',
    estimatedChangedFiles: 1,
  }))
  const fresh = store.recordCandidates({ routineId, runId: run.id, candidates: found, at: scheduledFor })
  const requested = store.stageCandidateIssues({ commands: candidateIssueCommands(fresh, run), at: scheduledFor })
  const evidence = `daily-checkin on ${site} | ${found.length} found | ${fresh.length} new | 0 already known | 0 outside allowed scope | 0 over 5 files | ${requested} issues requested`
  store.stageRoutineReport({
    command: routineReportCommand({
      repository: site,
      routineId,
      routineName: 'daily-checkin',
      run,
      report: { _tag: 'Scanned', evidence, tally: { found: found.length, fresh: fresh.length, known: 0, outsideScope: 0, oversized: { limit: 5, count: 0 }, fingerprints: found.map(candidate => candidate.fingerprint) }, detail: outcome.report, ...(outcome.verdict === undefined ? {} : { verdict: outcome.verdict }) },
    }),
    at: scheduledFor,
  })
  store.completeRoutineRun({ taskId: run.id, workerId: run.state.workerId, fence: run.state.fence, at: scheduledFor, evidence })
}

/** Reads yield rows back into objects through the evidence's own legend. */
function decodeYield({ routineYield }: ReturnType<typeof collectAgentRetroEvidence>) {
  return routineYield.rows.map(row => Object.fromEntries(routineYield.columns.map((column, index) => [column, row[index]])))
}

describe('agent retro Routine yield', () => {
  it('reports a week of AMBER check-ins without Candidates as a stalled Routine', () => {
    const store = checkinStore()
    // Outside the window: an older run that still filed work must not hide the stall.
    checkin(store, daysAgo(9), { verdict: green, report: quiet, candidates: 2 })
    for (const days of week)
      checkin(store, daysAgo(days), { verdict: amber, report: blocked })

    expect(decodeYield(collectAgentRetroEvidence(store, now))).toEqual([{
      routine: 'daily-checkin',
      mode: 'propose',
      repositories: 1,
      runs: 7,
      completed: 7,
      green: 0,
      amber: 7,
      red: 0,
      noVerdict: 0,
      coverageIncomplete: 7,
      candidates: 0,
      issuesRequested: 0,
      controllerRequests: 7,
      stalled: true,
      requests: [request],
    }])
  })

  it('reads a GREEN week without Candidates as quiet, not stalled', () => {
    const store = checkinStore()
    for (const days of week)
      checkin(store, daysAgo(days), { verdict: green, report: quiet })

    expect(decodeYield(collectAgentRetroEvidence(store, now))).toMatchObject([{ green: 7, candidates: 0, controllerRequests: 0, stalled: false, requests: [] }])
  })

  it('stops calling a Routine stalled once one run files a Candidate', () => {
    const store = checkinStore()
    for (const days of week)
      checkin(store, daysAgo(days), { verdict: amber, report: blocked, candidates: days === 3.5 ? 1 : 0 })

    expect(decodeYield(collectAgentRetroEvidence(store, now))).toMatchObject([{ amber: 7, candidates: 1, issuesRequested: 1, stalled: false }])
  })

  it.each([
    [4, false],
    [5, true],
  ])('reads %i AMBER runs without Candidates as stalled: %s', (runs, stalled) => {
    const store = checkinStore()
    for (const days of week.slice(0, runs))
      checkin(store, daysAgo(days), { verdict: amber, report: blocked })

    expect(decodeYield(collectAgentRetroEvidence(store, now))).toMatchObject([{ amber: runs, stalled }])
  })

  it('never calls a report-mode Routine stalled', () => {
    const store = checkinStore('report')
    for (const days of week)
      checkin(store, daysAgo(days), { verdict: amber, report: blocked })

    expect(decodeYield(collectAgentRetroEvidence(store, now))).toMatchObject([{ mode: 'report', amber: 7, stalled: false }])
  })

  it('counts runs without a verdict apart from non-GREEN runs', () => {
    const store = checkinStore()
    for (const days of week)
      checkin(store, daysAgo(days), { report: blocked })

    expect(decodeYield(collectAgentRetroEvidence(store, now))).toMatchObject([{ noVerdict: 7, amber: 0, red: 0, stalled: false }])
  })

  // Worker reports from November 2026 asked the Controller in each of these forms.
  it.each([
    [`1. ${request}`, request],
    ['- **Controller:** supply complete issue bodies and closed history.', request],
    ['1. Controller owner: supply the active Worker version. Existing #33.', 'Controller owner: supply the active Worker version. Existing #33.'],
    ['Coverage incomplete. Next action: controller supplies issue bodies and closed history.', 'Next action: controller supplies issue bodies and closed history.'],
    ['2. Scheduler owner: diagnose starvation. Controller must supply matching ownership records.', 'Controller must supply matching ownership records.'],
  ])('reads %j as a Controller request', (line, expected) => {
    const store = checkinStore()
    checkin(store, daysAgo(1), { verdict: amber, report: `## AMBER nuxtseo.com\n\n**Needs you**\n\n${line}\n` })

    expect(decodeYield(collectAgentRetroEvidence(store, now))).toMatchObject([{ controllerRequests: 1, requests: [expected] }])
  })

  it.each([
    'The Controller filed #12 yesterday.',
    'Controller lists were checked first.',
    '- Controller Service and Baseline ownership evidence was unavailable.',
  ])('reads %j as no Controller request', (line) => {
    const store = checkinStore()
    checkin(store, daysAgo(1), { verdict: amber, report: `## AMBER nuxtseo.com\n\n${line}\n` })

    expect(decodeYield(collectAgentRetroEvidence(store, now))).toMatchObject([{ controllerRequests: 0, requests: [] }])
  })
})
