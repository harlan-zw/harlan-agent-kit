import type { AgentTurnRecord } from '../src/agent-turn-store.ts'
import type { PaybackPricing, PaybackTaskFact } from '../src/payback.ts'
import { describe, expect, it } from 'vitest'
import { buildPayback } from '../src/payback.ts'

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

describe('buildPayback', () => {
  it('prices each kind from dated rates and divides by its merged pull requests', () => {
    const report = buildPayback({
      turns: [turn({ taskId: 'a', role: 'issue_work' }), turn({ taskId: 'b', role: 'issue_work' })],
      tasks: [task('a'), task('b', { pullRequest: 'Open' })],
      pricing,
    })

    // 100k fresh at $2, 900k cached at $0.10, 10k output at $10: $0.39 per turn.
    expect(report.kinds).toEqual([expect.objectContaining({
      work: 'issue_work',
      agentTurns: 2,
      cost: { _tag: 'Priced', usd: expect.closeTo(0.78, 6), unpricedTurns: 0 },
      outcomes: { useful: 1, wasted: 0, open: 1, unrecorded: 0 },
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
      pricing,
    })

    expect(report.kinds[0]).toEqual(expect.objectContaining({
      outcomes: { useful: 1, wasted: 1, open: 0, unrecorded: 0 },
      wastedShare: 0.8,
      verdict: { _tag: 'Tune', reason: '80% of settled Agent turns produced nothing.' },
    }))
  })

  it('names a kind with spend and no useful outcome for cutting', () => {
    const report = buildPayback({
      turns: [turn({ taskId: 'closed', role: 'baseline_repair' })],
      tasks: [task('closed', { pullRequest: 'Closed' })],
      pricing,
    })

    expect(report.kinds[0]?.verdict).toEqual({ _tag: 'Cut', reason: '1 settled, none useful.' })
  })

  it('measures first when the Journal records no useful outcome for the work', () => {
    const report = buildPayback({
      turns: [turn({ taskId: 'review-1', role: 'adversarial_review' }), turn({ taskId: 'run-1', role: 'routine_scan' })],
      tasks: [task('review-1', { state: null }), task('run-1', { state: null })],
      pricing,
    })

    expect(report.kinds.map(kind => [kind.work, kind.verdict._tag])).toEqual([
      ['adversarial_review', 'MeasureFirst'],
      ['routine', 'MeasureFirst'],
    ])
  })

  it('leaves dollars and break-even unset for a model with no rate', () => {
    const report = buildPayback({
      turns: [turn({ taskId: 'a', role: 'issue_work', provider: 'opencode', model: 'zai-coding-plan/glm-5.3' })],
      tasks: [task('a')],
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
      pricing,
    })

    expect(report.kinds[0]).toEqual(expect.objectContaining({
      failedTurns: 1,
      turnsWithoutUsage: 1,
      cost: { _tag: 'Unpriced', models: [] },
    }))
  })
})
