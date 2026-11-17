import type { AgentTurnRecord } from '../src/agent-turn-store.ts'
import type { PaybackPricing, PaybackRoutineRunFact, PaybackTaskFact } from '../src/payback.ts'
import { describe, expect, it } from 'vitest'
import { buildPayback, paybackRoutineRunOutcome } from '../src/payback.ts'

const sol = { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 }
const pricing: PaybackPricing = { rates: { 'gpt-6.1-sol': sol }, ratesCheckedOn: '2026-11-17', hourlyValue: 150 }

function turn(overrides: Partial<AgentTurnRecord> & Pick<AgentTurnRecord, 'taskId' | 'role'>): AgentTurnRecord {
  return {
    id: `${overrides.taskId}-${Math.random()}`,
    repository: 'harlan-zw/example',
    itemNumber: 1,
    provider: 'codex',
    model: 'gpt-6.1-sol',
    reasoningEffort: null,
    sessionId: 'thread-1',
    startedAt: '2026-11-10T00:00:00.000Z',
    completedAt: '2026-11-10T00:01:00.000Z',
    outcome: 'Answered',
    usage: { _tag: 'Available', input: 1_000_000, cachedInput: 900_000, cacheWrite: 0, output: 10_000, reasoning: 0 },
    sessionTotal: null,
    ...overrides,
  }
}

function task(taskId: string, overrides: Partial<PaybackTaskFact> = {}): PaybackTaskFact {
  return { taskId, state: 'Completed', published: true, pullRequest: 'Merged', ...overrides }
}

function routineRun(runId: string, overrides: Partial<PaybackRoutineRunFact> = {}): PaybackRoutineRunFact {
  return {
    runId,
    work: { _tag: 'Routine', name: 'ci-review' },
    mode: 'propose',
    state: 'Completed',
    candidates: { merged: 0, open: 0, closed: 0 },
    ...overrides,
  }
}

describe('buildPayback', () => {
  it('prices each kind from dated rates and divides by its merged pull requests', () => {
    const report = buildPayback({
      turns: [turn({ taskId: 'a', role: 'issue_work' }), turn({ taskId: 'b', role: 'issue_work' })],
      tasks: [task('a'), task('b', { pullRequest: 'Open' })],
      routineRuns: [],
      pricing,
    })

    // 100k fresh at $2, 900k cached at $0.10, 10k output at $10: $0.39 per turn.
    expect(report.kinds).toEqual([expect.objectContaining({
      work: { _tag: 'Role', role: 'issue_work' },
      agentTurns: 2,
      cost: { _tag: 'Priced', usd: expect.closeTo(0.78, 6), unpricedTurns: 0 },
      outcomes: { useful: 1, wasted: 0, actionRequired: 0, open: 1, unrecorded: 0 },
      costPerUseful: expect.closeTo(0.78, 6),
      breakEvenMinutes: expect.closeTo(0.312, 6),
      verdict: { _tag: 'Keep' },
    })])
  })

  it('asks for tuning when most settled turns went to work that published nothing', () => {
    const report = buildPayback({
      turns: [
        turn({ taskId: 'merged', role: 'conflict_resolution' }),
        ...Array.from({ length: 4 }, () => turn({ taskId: 'loop', role: 'conflict_resolution' })),
      ],
      tasks: [task('merged'), task('loop', { state: 'Superseded', published: false, pullRequest: 'Open' })],
      routineRuns: [],
      pricing,
    })

    expect(report.kinds[0]).toEqual(expect.objectContaining({
      outcomes: { useful: 1, wasted: 1, actionRequired: 0, open: 0, unrecorded: 0 },
      wastedShare: 0.8,
      verdict: { _tag: 'Tune', reason: '80% of Agent turns went to work that produced nothing or needs Action required.' },
    }))
  })

  it('counts turns on a Task stuck in Action required against the work, not as open', () => {
    const report = buildPayback({
      turns: [
        turn({ taskId: 'merged', role: 'conflict_resolution' }),
        ...Array.from({ length: 5 }, () => turn({ taskId: 'blocked', role: 'conflict_resolution' })),
      ],
      tasks: [task('merged'), task('blocked', { state: 'ActionRequired', published: false, pullRequest: 'Open' })],
      routineRuns: [],
      pricing,
    })

    expect(report.kinds[0]).toEqual(expect.objectContaining({
      outcomes: { useful: 1, wasted: 0, actionRequired: 1, open: 0, unrecorded: 0 },
      wastedShare: 5 / 6,
      verdict: expect.objectContaining({ _tag: 'Tune' }),
    }))
  })

  it('measures first when most turns have no recorded outcome, even beside a merge', () => {
    const report = buildPayback({
      turns: Array.from({ length: 4 }, (_, index) => turn({ taskId: `run-${index}`, role: 'routine_scan' })),
      tasks: [],
      routineRuns: [
        routineRun('run-0', { mode: 'report' }),
        routineRun('run-1', { mode: 'report' }),
        routineRun('run-2', { mode: 'report' }),
        routineRun('run-3', { candidates: { merged: 1, open: 0, closed: 0 } }),
      ],
      pricing,
    })

    expect(report.kinds[0]).toEqual(expect.objectContaining({
      outcomes: { useful: 1, wasted: 0, actionRequired: 0, open: 0, unrecorded: 3 },
      verdict: { _tag: 'MeasureFirst', reason: 'No useful outcome is recorded for most of this work yet.' },
    }))
  })

  it('reports each Routine on its own row, judged by what its Candidates became', () => {
    const report = buildPayback({
      turns: [
        turn({ taskId: 'seo-1', role: 'routine_scan' }),
        turn({ taskId: 'ci-merged', role: 'routine_scan' }),
        turn({ taskId: 'ci-quiet', role: 'routine_scan' }),
        turn({ taskId: 'merged', role: 'issue_work' }),
      ],
      // The Task facts list every spent id. A Routine run comes back with no Task state.
      tasks: [task('merged'), task('ci-merged', { state: null }), task('ci-quiet', { state: null }), task('seo-1', { state: null })],
      routineRuns: [
        routineRun('ci-merged', { candidates: { merged: 1, open: 2, closed: 1 } }),
        routineRun('ci-quiet'),
        routineRun('seo-1', { work: { _tag: 'Routine', name: 'seo-review' }, candidates: { merged: 0, open: 0, closed: 2 } }),
      ],
      pricing,
    })

    expect(report.kinds.map(kind => [kind.work, kind.outcomes, kind.verdict._tag])).toEqual([
      [{ _tag: 'Role', role: 'issue_work' }, { useful: 1, wasted: 0, actionRequired: 0, open: 0, unrecorded: 0 }, 'Keep'],
      [{ _tag: 'Routine', name: 'ci-review' }, { useful: 1, wasted: 1, actionRequired: 0, open: 0, unrecorded: 0 }, 'Keep'],
      [{ _tag: 'Routine', name: 'seo-review' }, { useful: 0, wasted: 1, actionRequired: 0, open: 0, unrecorded: 0 }, 'Cut'],
    ])
  })

  it('asks for tuning when most scans of a Routine proposed nothing', () => {
    const report = buildPayback({
      turns: ['found', 'quiet-1', 'quiet-2'].map(taskId => turn({ taskId, role: 'routine_scan' })),
      tasks: [],
      routineRuns: [routineRun('found', { candidates: { merged: 1, open: 0, closed: 0 } }), routineRun('quiet-1'), routineRun('quiet-2', { state: 'Failed' })],
      pricing,
    })

    expect(report.kinds[0]).toEqual(expect.objectContaining({
      work: { _tag: 'Routine', name: 'ci-review' },
      outcomes: { useful: 1, wasted: 2, actionRequired: 0, open: 0, unrecorded: 0 },
      verdict: { _tag: 'Tune', reason: '67% of Agent turns went to work that produced nothing or needs Action required.' },
    }))
  })

  it('names a kind with spend and no useful outcome for cutting', () => {
    const report = buildPayback({
      turns: [turn({ taskId: 'closed', role: 'baseline_repair' })],
      tasks: [task('closed', { pullRequest: 'Closed' })],
      routineRuns: [],
      pricing,
    })

    expect(report.kinds[0]?.verdict).toEqual({ _tag: 'Cut', reason: '1 settled, none useful.' })
  })

  it('measures first when the Journal records no useful outcome for the work', () => {
    const report = buildPayback({
      turns: [turn({ taskId: 'review-1', role: 'adversarial_review' }), turn({ taskId: 'run-1', role: 'routine_scan' })],
      tasks: [task('review-1', { state: null }), task('run-1', { state: null })],
      routineRuns: [],
      pricing,
    })

    expect(report.kinds.map(kind => [kind.work, kind.verdict._tag])).toEqual([
      [{ _tag: 'Role', role: 'adversarial_review' }, 'MeasureFirst'],
      [{ _tag: 'UnnamedRoutine' }, 'MeasureFirst'],
    ])
  })

  it('leaves dollars and break-even unset for a model with no rate', () => {
    const report = buildPayback({
      turns: [turn({ taskId: 'a', role: 'issue_work', provider: 'opencode', model: 'zai-coding-plan/glm-5.3' })],
      tasks: [task('a')],
      routineRuns: [],
      pricing: { rates: {}, ratesCheckedOn: null, hourlyValue: null },
    })

    expect(report.kinds[0]).toEqual(expect.objectContaining({
      cost: { _tag: 'Unpriced', models: ['zai-coding-plan/glm-5.3'] },
      costPerUseful: null,
      breakEvenMinutes: null,
    }))
  })

  it('counts turns without usage separately instead of pricing them at zero', () => {
    const report = buildPayback({
      turns: [turn({ taskId: 'a', role: 'review_fix', usage: { _tag: 'Unavailable' }, outcome: 'Failed' })],
      tasks: [task('a', { state: 'Failed', published: false, pullRequest: 'None' })],
      routineRuns: [],
      pricing,
    })

    expect(report.kinds[0]).toEqual(expect.objectContaining({
      failedTurns: 1,
      turnsWithoutUsage: 1,
      cost: { _tag: 'Unpriced', models: [] },
    }))
  })
})

describe('paybackRoutineRunOutcome', () => {
  it.each([
    ['one merged Candidate makes the run useful beside open ones', routineRun('a', { candidates: { merged: 1, open: 3, closed: 2 } }), { _tag: 'Useful' }],
    ['a pending Candidate keeps the run open', routineRun('a', { candidates: { merged: 0, open: 1, closed: 2 } }), { _tag: 'Open' }],
    ['Candidates that all closed unmerged waste the run', routineRun('a', { candidates: { merged: 0, open: 0, closed: 2 } }), { _tag: 'Wasted', reason: 'ClosedUnmerged' }],
    ['a settled scan that proposed nothing wastes its turn', routineRun('a', { state: 'Failed' }), { _tag: 'Wasted', reason: 'NothingProposed' }],
    ['a run waiting on a person counts as blocked', routineRun('a', { state: 'ActionRequired' }), { _tag: 'ActionRequired' }],
    ['a run still scanning is open', routineRun('a', { state: 'Running' }), { _tag: 'Open' }],
    ['a report run files no issue, so nothing is recorded', routineRun('a', { mode: 'report' }), { _tag: 'Unrecorded' }],
  ] as const)('%s', (_, fact, outcome) => {
    expect(paybackRoutineRunOutcome(fact)).toEqual(outcome)
  })
})
