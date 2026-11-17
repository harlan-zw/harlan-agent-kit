import type { Trial } from '../src/trials.ts'
import type { ReviewGates } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { collectTrialReportEvidence, suggestVerdict } from '../src/trial-report.ts'
import { TRIALS } from '../src/trials.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

type Store = ReturnType<typeof openJournalStore>

const stores: Store[] = []
afterEach(() => {
  stores.splice(0).forEach(store => store.close())
})

function createStore(repositories: string[]): Store {
  const store = openJournalStore(':memory:')
  stores.push(store)
  store.syncRepositories(repositories.map(github => repositoryMapping({ github })), '2026-11-01T00:00:00.000Z')
  return store
}

const start = '2026-11-18T00:00:00.000Z'
const trialText = { metric: 'Fixture metric.', keepRule: 'Fixture keep rule.', killRule: 'Fixture kill rule.', before: 'Fixture before.' }

const checkinTrial: Trial = {
  _tag: 'Measured',
  id: 'checkin',
  title: '1. Check-in when changed',
  start: { _tag: 'On', at: start },
  weeks: 4,
  ...trialText,
  measure: { _tag: 'CheckinWhenChanged', whenChangedRepositories: ['harlan-zw/changed'], everyRunRepositories: ['harlan-zw/every'], priorDays: 14 },
}

const discussionTrial: Trial = {
  _tag: 'Measured',
  id: 'discussion',
  title: '3. Discussion route',
  start: { _tag: 'On', at: start },
  weeks: 2,
  ...trialText,
  measure: { _tag: 'DiscussionRouteShadow', labelSample: 10, killConfidence: 0.9, minimumTriageShare: 0.1, listLimit: 25 },
}

const pathRuleTrial: Trial = {
  _tag: 'Measured',
  id: 'path-rule',
  title: '4. Path rule',
  start: { _tag: 'FirstEvent', stream: 'review_run', event: 'path_rule_shadow' },
  weeks: 2,
  ...trialText,
  measure: { _tag: 'PathRuleShadow', minimumFlaggedShare: 0.15, listLimit: 20 },
}

function agentRun(repository: string, issues: number): string {
  return `daily-checkin on ${repository} | 2 found | ${issues} new | 0 already known | 0 outside allowed scope | 0 over 5 files | ${issues} issues requested`
}

function unchangedRun(repository: string): string {
  return `daily-checkin on ${repository} | unchanged since run earlier | head abc123 | no deploy workflow configured, so head SHA only | no Agent turn | 0 issues requested`
}

/** Opens, claims, and settles one daily-checkin run through the real scheduler. */
function settleCheckin(store: Store, repository: string, scheduledFor: string, outcome: { evidence: string, input?: number } | 'failed'): void {
  const routineId = `${repository}:daily-checkin`
  const opened = new Date(Date.parse(scheduledFor) + 60_000).toISOString()
  store.openRoutineRun({ routineId, scheduledFor, specSha: 'abc123', at: opened })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const run = store.claimNextRoutineRun('worker-1', opened, 60 * 60_000)
    if (run === null)
      throw new Error(`Expected the ${repository} run at ${scheduledFor}.`)
    if (outcome !== 'failed') {
      store.completeRoutineRun({
        taskId: run.id,
        workerId: run.state.workerId,
        fence: run.state.fence,
        at: opened,
        evidence: outcome.evidence,
        usage: outcome.input === undefined
          ? { _tag: 'Unavailable' }
          : { _tag: 'Available', input: outcome.input, cachedInput: 0, cacheWrite: 0, output: 1, reasoning: 0 },
      })
      return
    }
    if (store.failRoutineRun({ taskId: run.id, workerId: run.state.workerId, fence: run.state.fence, at: opened, reason: 'The provider failed.' }) === 'Failed')
      return
  }
}

describe('daily-checkin when changed trial', () => {
  function seed(): Store {
    const store = createStore(['harlan-zw/changed', 'harlan-zw/every', 'harlan-zw/other'])
    const entry = { name: 'daily-checkin' as const, crons: ['0 7 * * *'], timeZone: 'Australia/Melbourne', mode: 'propose' as const, enabled: true }
    store.syncRoutines({ repository: 'harlan-zw/changed', specSha: 'abc123', entries: [{ ...entry, when: 'changed' }], at: '2026-11-01T00:00:00.000Z' })
    store.syncRoutines({ repository: 'harlan-zw/every', specSha: 'abc123', entries: [entry], at: '2026-11-01T00:00:00.000Z' })
    store.syncRoutines({ repository: 'harlan-zw/other', specSha: 'abc123', entries: [entry], at: '2026-11-01T00:00:00.000Z' })
    // Fourteen days before the trial.
    settleCheckin(store, 'harlan-zw/changed', '2026-11-03T23:59:00.000Z', { evidence: agentRun('harlan-zw/changed', 5), input: 100 })
    settleCheckin(store, 'harlan-zw/changed', '2026-11-10T00:00:00.000Z', { evidence: agentRun('harlan-zw/changed', 1), input: 100 })
    settleCheckin(store, 'harlan-zw/changed', '2026-11-17T23:59:00.000Z', { evidence: agentRun('harlan-zw/changed', 0), input: 100 })
    settleCheckin(store, 'harlan-zw/every', '2026-11-10T00:00:00.000Z', { evidence: agentRun('harlan-zw/every', 0), input: 100 })
    settleCheckin(store, 'harlan-zw/every', '2026-11-11T00:00:00.000Z', { evidence: agentRun('harlan-zw/every', 0), input: 100 })
    // The trial so far. The first run lands on the start instant.
    settleCheckin(store, 'harlan-zw/changed', start, { evidence: agentRun('harlan-zw/changed', 1), input: 200 })
    settleCheckin(store, 'harlan-zw/changed', '2026-11-21T00:00:00.000Z', { evidence: unchangedRun('harlan-zw/changed') })
    settleCheckin(store, 'harlan-zw/changed', '2026-11-26T00:00:00.000Z', { evidence: unchangedRun('harlan-zw/changed') })
    settleCheckin(store, 'harlan-zw/changed', '2026-11-27T00:00:00.000Z', { evidence: unchangedRun('harlan-zw/changed') })
    settleCheckin(store, 'harlan-zw/every', '2026-11-20T00:00:00.000Z', { evidence: agentRun('harlan-zw/every', 0), input: 300 })
    settleCheckin(store, 'harlan-zw/every', '2026-11-21T00:00:00.000Z', { evidence: agentRun('harlan-zw/every', 0), input: 300 })
    settleCheckin(store, 'harlan-zw/every', '2026-11-26T00:00:00.000Z', { evidence: agentRun('harlan-zw/every', 1), input: 300 })
    settleCheckin(store, 'harlan-zw/every', '2026-11-27T00:00:00.000Z', { evidence: agentRun('harlan-zw/every', 0), input: 300 })
    settleCheckin(store, 'harlan-zw/every', '2026-11-28T00:00:00.000Z', 'failed')
    settleCheckin(store, 'harlan-zw/other', '2026-11-20T00:00:00.000Z', { evidence: agentRun('harlan-zw/other', 0), input: 300 })
    // The report instant itself belongs to next week.
    settleCheckin(store, 'harlan-zw/every', '2026-12-02T00:00:00.000Z', { evidence: agentRun('harlan-zw/every', 9), input: 300 })
    return store
  }

  it('compares issues and Agent runs per site per week for both groups of sites', () => {
    const evidence = collectTrialReportEvidence(seed(), new Date('2026-12-02T00:00:00.000Z'), [checkinTrial])
    const [reading] = evidence.trials
    if (reading?._tag !== 'Measured' || reading.metrics?._tag !== 'CheckinWhenChanged')
      throw new Error('Expected a measured check-in trial.')

    expect(reading.state).toEqual({ _tag: 'Running', startedAt: start, endsAt: '2026-12-16T00:00:00.000Z', week: 3, weeks: 4 })
    expect(reading.metrics.toDate.whenChanged).toEqual({
      sites: 1,
      runs: 4,
      agentRuns: 1,
      unchangedRuns: 3,
      failedRuns: 0,
      issuesRequested: 1,
      inputTokens: 200,
      issuesPerSiteWeek: 0.5,
      agentRunsPerSiteWeek: 0.5,
    })
    expect(reading.metrics.toDate.everyRun).toMatchObject({ sites: 1, runs: 5, agentRuns: 4, unchangedRuns: 0, failedRuns: 1, issuesRequested: 1, inputTokens: 1200, issuesPerSiteWeek: 0.5, agentRunsPerSiteWeek: 2 })
    expect(reading.metrics.lastSevenDays.whenChanged).toMatchObject({ agentRuns: 0, unchangedRuns: 2, issuesPerSiteWeek: 0 })
    expect(reading.metrics.lastSevenDays.everyRun).toMatchObject({ agentRuns: 2, failedRuns: 1, issuesPerSiteWeek: 1, agentRunsPerSiteWeek: 2 })
    expect(reading.metrics.beforeTrial.whenChanged).toMatchObject({ agentRuns: 2, issuesRequested: 1, agentRunsPerSiteWeek: 1 })
    expect(reading.metrics.beforeTrial.everyRun).toMatchObject({ agentRuns: 2, issuesRequested: 0, agentRunsPerSiteWeek: 1 })
    expect(reading.metrics.otherRepositories).toEqual(['harlan-zw/other'])
    expect(reading.metrics.scheduleMismatches).toEqual([])

    expect(reading.keep.map(rule => rule._tag)).toEqual(['Met', 'Met'])
    expect(reading.kill).toEqual([{ _tag: 'NeedsHuman', detail: expect.stringContaining('3 unchanged runs') }])
    expect(reading.suggestion).toEqual({ verdict: 'Continue', reason: expect.stringContaining('Week 3 of 4') })
    expect(reading.markdown).toContain('| Issues requested, `when: changed` | 0 | 0.5 | 0.5 |')
    expect(reading.markdown).toContain('| Agent runs, every run | 2 | 2 | 1 |')
  })

  it('names a site whose schedule does not match its group', () => {
    const store = createStore(['harlan-zw/changed', 'harlan-zw/every'])
    const entry = { name: 'daily-checkin' as const, crons: ['0 7 * * 1'], timeZone: 'UTC', mode: 'propose' as const, enabled: true }
    store.syncRoutines({ repository: 'harlan-zw/changed', specSha: 'abc123', entries: [entry], at: '2026-11-01T00:00:00.000Z' })
    store.syncRoutines({ repository: 'harlan-zw/every', specSha: 'abc123', entries: [{ ...entry, when: 'changed' }], at: '2026-11-01T00:00:00.000Z' })

    const [reading] = collectTrialReportEvidence(store, new Date('2026-11-25T00:00:00.000Z'), [checkinTrial]).trials
    if (reading?._tag !== 'Measured' || reading.metrics?._tag !== 'CheckinWhenChanged')
      throw new Error('Expected a measured check-in trial.')

    expect(reading.metrics.scheduleMismatches).toEqual([
      { repository: 'harlan-zw/changed', expected: 'WhenChanged', actual: 'EveryRun' },
      { repository: 'harlan-zw/every', expected: 'EveryRun', actual: 'WhenChanged' },
    ])
    expect(reading.keep.map(rule => rule._tag)).toEqual(['NotYetMeasurable', 'NotYetMeasurable'])
    expect(reading.markdown).toContain('harlan-zw/changed')
  })
})

describe('discussion route shadow trial', () => {
  function observe(store: Store, number: number, at: string, reading: { route: 'DISCUSSION' | 'AGENT_TRIAGE', confidence: number, skipsTriage: boolean }): void {
    const inserted = store.recordObservation({
      externalId: `issue-${number}-${at}`,
      observedAt: at,
      source: 'poll',
      subject: issueItem({ number, author: 'harlan-zw', updatedAt: at, title: `Issue ${number} at ${at}` }),
      issueTriage: {
        _tag: 'AgentTriage',
        reason: 'The Issue triage band is not configured.',
        reading: { mode: 'Shadow', band: 0.9, needsCodebaseReview: 0.1, ...reading },
      },
    })
    if (inserted._tag !== 'Inserted')
      throw new Error(`Expected a new Revision for issue ${number}.`)
  }

  it('counts each issue once by its latest reading and lists the DISCUSSION issues to label', () => {
    const store = createStore(['harlan-zw/example'])
    observe(store, 3, '2026-11-17T12:00:00.000Z', { route: 'DISCUSSION', confidence: 0.97, skipsTriage: true })
    observe(store, 1, '2026-11-19T00:00:00.000Z', { route: 'DISCUSSION', confidence: 0.85, skipsTriage: false })
    observe(store, 1, '2026-11-20T00:00:00.000Z', { route: 'DISCUSSION', confidence: 0.93, skipsTriage: true })
    observe(store, 2, '2026-11-20T00:00:00.000Z', { route: 'AGENT_TRIAGE', confidence: 0.7, skipsTriage: false })

    const [reading] = collectTrialReportEvidence(store, new Date('2026-11-25T00:00:00.000Z'), [discussionTrial]).trials
    if (reading?._tag !== 'Measured' || reading.metrics?._tag !== 'DiscussionRouteShadow')
      throw new Error('Expected a measured Discussion route trial.')

    expect(reading.metrics.toDate).toMatchObject({ classifiedIssues: 2, discussionIssues: 1, skipsTriageIssues: 1, skipsTriageShare: 0.5 })
    expect(reading.metrics.issues).toEqual([{
      issue: 'harlan-zw/example#1',
      url: 'https://github.com/harlan-zw/example/issues/1',
      confidence: 0.93,
      needsCodebaseReview: 0.1,
      skipsTriage: true,
    }])
    expect(reading.keep.map(rule => rule._tag)).toEqual(['NeedsHuman', 'Met'])
    expect(reading.kill).toEqual([{ _tag: 'NeedsHuman', detail: expect.stringContaining('1 issue') }])
    expect(reading.suggestion.verdict).toBe('Continue')
    expect(reading.markdown).toContain('[harlan-zw/example#1](https://github.com/harlan-zw/example/issues/1)')
    expect(reading.markdown).not.toContain('Issue 1 at')
  })
})

describe('path rule shadow trial', () => {
  function gates(failed?: keyof ReviewGates): ReviewGates {
    const passed = { _tag: 'Passed' as const, evidence: [{ label: 'fixture', sha256: 'e'.repeat(64) }] }
    const gates: ReviewGates = { merge: passed, review: passed, ci: passed }
    return failed === undefined ? gates : { ...gates, [failed]: { _tag: 'Failed', reason: 'Fixture failure.', evidence: [] } }
  }

  function reviewHead(store: Store, number: number, flagged: boolean, outcomes: Array<{ at: string, failed?: keyof ReviewGates }>): void {
    const headSha = String(number).repeat(20).slice(0, 40)
    const observed = store.recordObservation({
      externalId: `pull-${number}`,
      observedAt: outcomes[0]!.at,
      source: 'poll',
      subject: pullRequestItem({ number, headSha, mergeState: 'clean' }),
      pullRequestTriage: { _tag: 'Required', reason: 'rule: the classification service is not configured, so Review runs.', source: 'rule' },
      ...(flagged ? { pathRuleShadow: { verdict: 'ProseOnly' as const, fileCount: 2 } } : {}),
    })
    if (observed._tag !== 'Inserted')
      throw new Error(`Expected pull request ${number}.`)
    for (const [index, outcome] of outcomes.entries()) {
      const recorded = store.recordReviewRun({
        id: `review-${number}-${index}`,
        repository: 'harlan-zw/example',
        pullRequestNumber: number,
        revisionId: observed.revisionId,
        headSha,
        provider: 'codex',
        sessionId: `session-${number}-${index}`,
        model: 'gpt-5.6-sol',
        agentVersion: '1.0.0',
        skillDigest: 'f'.repeat(64),
        startedAt: outcome.at,
        completedAt: outcome.at,
        gates: gates(outcome.failed),
        confidence: 90,
        findings: [],
      })
      if (recorded._tag !== 'Inserted')
        throw new Error(`Expected Review run ${index} of pull request ${number}: ${JSON.stringify(recorded)}`)
    }
  }

  it('reports not started, never a zero share, before any head is flagged', () => {
    const store = createStore(['harlan-zw/example'])
    reviewHead(store, 26, false, [{ at: '2026-11-20T00:00:00.000Z' }])

    const [reading] = collectTrialReportEvidence(store, new Date('2026-11-25T00:00:00.000Z'), [pathRuleTrial]).trials
    if (reading?._tag !== 'Measured')
      throw new Error('Expected a measured path rule trial.')

    expect(reading.state._tag).toBe('NotStarted')
    expect(reading.metrics).toBeNull()
    expect(reading.keep.map(rule => rule._tag)).toEqual(['NotYetMeasurable', 'NotYetMeasurable'])
    expect(reading.suggestion.verdict).toBe('Continue')
    expect(reading.markdown).not.toContain('0%')
  })

  it('judges each head by its latest Review run and lists the flagged heads that ended Blocked', () => {
    const store = createStore(['harlan-zw/example'])
    reviewHead(store, 24, true, [{ at: '2026-11-19T00:00:00.000Z', failed: 'review' }])
    reviewHead(store, 25, true, [{ at: '2026-11-19T01:00:00.000Z', failed: 'ci' }, { at: '2026-11-19T02:00:00.000Z' }])
    reviewHead(store, 26, false, [{ at: '2026-11-20T00:00:00.000Z' }])

    const [reading] = collectTrialReportEvidence(store, new Date('2026-11-25T00:00:00.000Z'), [pathRuleTrial]).trials
    if (reading?._tag !== 'Measured' || reading.metrics?._tag !== 'PathRuleShadow')
      throw new Error('Expected a measured path rule trial.')

    expect(reading.state).toMatchObject({ _tag: 'Running', startedAt: '2026-11-19T00:00:00.000Z', week: 1 })
    expect(reading.metrics.toDate).toMatchObject({ reviewedHeads: 3, flaggedHeads: 2, flaggedEndedBlocked: 1 })
    expect(reading.metrics.blockedHeads).toEqual([{
      pullRequest: 'harlan-zw/example#24',
      url: 'https://github.com/harlan-zw/example/pull/24',
      headSha: '242424242424',
      fileCount: 2,
      failedGates: ['review'],
    }])
    expect(reading.keep.map(rule => rule._tag)).toEqual(['NotMet', 'Met'])
    expect(reading.kill).toEqual([{ _tag: 'NeedsHuman', detail: expect.stringContaining('1 flagged head') }])
    expect(reading.markdown).toContain('failed Review gates: review')
  })
})

describe('trial report evidence', () => {
  it('reads every trial, including a parked one, as JSON the Routine can carry', () => {
    const store = createStore(['harlan-zw/example'])
    const evidence = collectTrialReportEvidence(store, new Date('2026-11-25T00:00:00.000Z'))

    expect(JSON.parse(JSON.stringify(evidence))).toEqual(evidence)
    expect(evidence.observedAt).toBe('2026-11-25T00:00:00.000Z')
    expect(evidence.trials.map(trial => [trial.id, trial._tag, trial._tag === 'Measured' ? trial.state._tag : null, trial._tag === 'Measured' ? trial.suggestion.verdict : null]))
      .toEqual(TRIALS.map(trial => [
        trial.id,
        trial._tag,
        trial._tag === 'Parked' ? null : trial.start._tag === 'On' ? 'Running' : 'NotStarted',
        trial._tag === 'Parked' ? null : 'Continue',
      ]))
    const parked = evidence.trials.find(trial => trial._tag === 'Parked')
    expect(parked?.markdown).toContain('Parked.')
  })
})

describe('suggested trial verdict', () => {
  const ended = { _tag: 'Ended' as const, startedAt: start, endedAt: '2026-12-16T00:00:00.000Z' }
  const running = { _tag: 'Running' as const, startedAt: start, endsAt: '2026-12-16T00:00:00.000Z', week: 2, weeks: 4 }
  const met = { _tag: 'Met' as const, detail: 'Met in the fixture.' }
  const notMet = { _tag: 'NotMet' as const, detail: 'Missed in the fixture.' }
  const needsHarlan = { _tag: 'NeedsHuman' as const, detail: 'Check the fixture runs.' }

  it('keeps an ended trial whose keep rule is met, and names the checks left for Harlan', () => {
    expect(suggestVerdict(ended, [met, met], [needsHarlan])).toEqual({ verdict: 'Keep', reason: expect.stringContaining('Check the fixture runs.') })
  })

  it('kills an ended trial whose keep rule is not met', () => {
    expect(suggestVerdict(ended, [met, notMet], [needsHarlan])).toEqual({ verdict: 'Kill', reason: expect.stringContaining('Missed in the fixture.') })
  })

  it('waits for Harlan when a keep rule needs his judgement', () => {
    expect(suggestVerdict(ended, [needsHarlan, met], [])).toEqual({ verdict: 'Continue', reason: expect.stringContaining('Check the fixture runs.') })
  })

  it('kills a running trial once its kill rule is met', () => {
    expect(suggestVerdict(running, [met, met], [met])).toEqual({ verdict: 'Kill', reason: expect.stringContaining('Met in the fixture.') })
  })
})
