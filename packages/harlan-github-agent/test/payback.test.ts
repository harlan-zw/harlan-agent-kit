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
      outcomes: { useful: 1, wasted: 0, actionRequired: 0, open: 1, quiet: 0, unrecorded: 0 },
      costPerUseful: expect.closeTo(0.78, 6),
      breakEvenMinutes: expect.closeTo(0.312, 6),
    })])
  })

  it('measures first below five settled outcomes, for Tasks and Routines alike', () => {
    const report = buildPayback({
      turns: [
        ...['closed-1', 'closed-2', 'closed-3'].map(taskId => turn({ taskId, role: 'conflict_resolution' })),
        ...['quiet-1', 'quiet-2', 'quiet-3', 'quiet-4'].map(taskId => turn({ taskId, role: 'routine_scan' })),
      ],
      tasks: ['closed-1', 'closed-2', 'closed-3'].map(taskId => task(taskId, { pullRequest: 'Closed' })),
      routineRuns: ['quiet-1', 'quiet-2', 'quiet-3', 'quiet-4'].map(runId => routineRun(runId)),
      pricing,
    })

    expect(report.kinds.map(kind => kind.verdict)).toEqual([
      { _tag: 'MeasureFirst', reason: 'Fewer than 5 settled in this range.' },
      { _tag: 'MeasureFirst', reason: 'Fewer than 5 settled in this range.' },
    ])
  })

  it('asks for tuning when most settled turns went to work that published nothing', () => {
    const report = buildPayback({
      turns: [
        ...['merged-1', 'merged-2'].map(taskId => turn({ taskId, role: 'conflict_resolution' })),
        ...['loop-1', 'loop-2', 'loop-3'].flatMap(taskId => [turn({ taskId, role: 'conflict_resolution' }), turn({ taskId, role: 'conflict_resolution' })]),
      ],
      tasks: [task('merged-1'), task('merged-2'), ...['loop-1', 'loop-2', 'loop-3'].map(taskId => task(taskId, { state: 'Superseded', published: false, pullRequest: 'Open' }))],
      routineRuns: [],
      pricing,
    })

    expect(report.kinds[0]).toEqual(expect.objectContaining({
      outcomes: { useful: 2, wasted: 3, actionRequired: 0, open: 0, quiet: 0, unrecorded: 0 },
      wastedShare: 0.75,
      verdict: { _tag: 'Tune', reason: '75% of Agent turns went to work that produced nothing or needs Action required.' },
    }))
  })

  it('counts turns on a Task stuck in Action required against the work, not as open', () => {
    const report = buildPayback({
      turns: [
        ...['merged-1', 'merged-2', 'merged-3', 'merged-4'].map(taskId => turn({ taskId, role: 'conflict_resolution' })),
        ...Array.from({ length: 5 }, () => turn({ taskId: 'blocked', role: 'conflict_resolution' })),
      ],
      tasks: [...['merged-1', 'merged-2', 'merged-3', 'merged-4'].map(taskId => task(taskId)), task('blocked', { state: 'ActionRequired', published: false, pullRequest: 'Open' })],
      routineRuns: [],
      pricing,
    })

    expect(report.kinds[0]).toEqual(expect.objectContaining({
      outcomes: { useful: 4, wasted: 0, actionRequired: 1, open: 0, quiet: 0, unrecorded: 0 },
      wastedShare: 5 / 9,
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
      outcomes: { useful: 1, wasted: 0, actionRequired: 0, open: 0, quiet: 0, unrecorded: 3 },
      verdict: { _tag: 'MeasureFirst', reason: 'No useful outcome is recorded for most of this work yet.' },
    }))
  })

  it('reports each Routine on its own row, counted by what its Candidates became', () => {
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

    expect(report.kinds.map(kind => [kind.work, kind.outcomes])).toEqual([
      [{ _tag: 'Role', role: 'issue_work' }, { useful: 1, wasted: 0, actionRequired: 0, open: 0, quiet: 0, unrecorded: 0 }],
      [{ _tag: 'Routine', name: 'ci-review' }, { useful: 1, wasted: 0, actionRequired: 0, open: 0, quiet: 1, unrecorded: 0 }],
      [{ _tag: 'Routine', name: 'seo-review' }, { useful: 0, wasted: 1, actionRequired: 0, open: 0, quiet: 0, unrecorded: 0 }],
    ])
  })

  it('keeps a monitor whose quiet runs outnumber its merges, and charges their spend to each merge', () => {
    const quiet = Array.from({ length: 25 }, (_, index) => `quiet-${index}`)
    const merged = Array.from({ length: 6 }, (_, index) => `merged-${index}`)
    const report = buildPayback({
      turns: [...merged, ...quiet].map(taskId => turn({ taskId, role: 'routine_scan' })),
      tasks: [],
      routineRuns: [
        ...merged.map(runId => routineRun(runId, { work: { _tag: 'Routine', name: 'agent-retro' }, candidates: { merged: 1, open: 0, closed: 0 } })),
        ...quiet.map(runId => routineRun(runId, { work: { _tag: 'Routine', name: 'agent-retro' } })),
      ],
      pricing,
    })

    // 31 turns at $0.39 each, over 6 useful runs.
    expect(report.kinds[0]).toEqual(expect.objectContaining({
      work: { _tag: 'Routine', name: 'agent-retro' },
      outcomes: { useful: 6, wasted: 0, actionRequired: 0, open: 0, quiet: 25, unrecorded: 0 },
      wastedShare: 0,
      costPerUseful: expect.closeTo(31 * 0.39 / 6, 6),
      verdict: { _tag: 'Keep' },
    }))
  })

  it('cuts a Routine that spent turns and merged no proposal', () => {
    const report = buildPayback({
      turns: ['quiet-1', 'quiet-2', 'quiet-3', 'quiet-4', 'failed'].map(taskId => turn({ taskId, role: 'routine_scan' })),
      tasks: [],
      routineRuns: [...['quiet-1', 'quiet-2', 'quiet-3', 'quiet-4'].map(runId => routineRun(runId)), routineRun('failed', { state: 'Failed' })],
      pricing,
    })

    expect(report.kinds[0]?.verdict).toEqual({ _tag: 'Cut', reason: '5 runs, no merged proposal.' })
  })

  it('asks for tuning when most settled turns of a Routine went to closed proposals', () => {
    const report = buildPayback({
      turns: ['merged', 'closed-1', 'closed-2', 'quiet-1', 'quiet-2'].map(taskId => turn({ taskId, role: 'routine_scan' })),
      tasks: [],
      routineRuns: [
        routineRun('merged', { candidates: { merged: 1, open: 0, closed: 0 } }),
        routineRun('closed-1', { candidates: { merged: 0, open: 0, closed: 1 } }),
        routineRun('closed-2', { candidates: { merged: 0, open: 0, closed: 3 } }),
        routineRun('quiet-1'),
        routineRun('quiet-2'),
      ],
      pricing,
    })

    expect(report.kinds[0]).toEqual(expect.objectContaining({
      outcomes: { useful: 1, wasted: 2, actionRequired: 0, open: 0, quiet: 2, unrecorded: 0 },
      verdict: { _tag: 'Tune', reason: '67% of settled Agent turns went to closed proposals, failed scans, or Action required.' },
    }))
  })

  it('names a kind with spend and no useful outcome for cutting', () => {
    const report = buildPayback({
      turns: ['closed-1', 'closed-2', 'closed-3', 'closed-4', 'closed-5'].map(taskId => turn({ taskId, role: 'baseline_repair' })),
      tasks: ['closed-1', 'closed-2', 'closed-3', 'closed-4', 'closed-5'].map(taskId => task(taskId, { pullRequest: 'Closed' })),
      routineRuns: [],
      pricing,
    })

    expect(report.kinds[0]?.verdict).toEqual({ _tag: 'Cut', reason: '5 settled, none useful.' })
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
    ['a completed scan that proposed nothing is quiet', routineRun('a'), { _tag: 'Quiet' }],
    ['a failed scan that proposed nothing wastes its turn', routineRun('a', { state: 'Failed' }), { _tag: 'Wasted', reason: 'NothingProposed' }],
    ['a run waiting on a person counts as blocked', routineRun('a', { state: 'ActionRequired' }), { _tag: 'ActionRequired' }],
    ['a run still scanning is open', routineRun('a', { state: 'Running' }), { _tag: 'Open' }],
    ['a report run files no issue, so nothing is recorded', routineRun('a', { mode: 'report' }), { _tag: 'Unrecorded' }],
  ] as const)('%s', (_, fact, outcome) => {
    expect(paybackRoutineRunOutcome(fact)).toEqual(outcome)
  })
})
