import type { PaybackKind, PaybackReport } from '../src/payback.ts'
import { describe, expect, it } from 'vitest'
import { paybackRatesText, paybackRows } from '../dashboard/app/utils/payback.ts'

function kind(overrides: Partial<PaybackKind>): PaybackKind {
  return {
    work: 'issue_work',
    agentTurns: 10,
    failedTurns: 0,
    turnsWithoutUsage: 0,
    tokens: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    cost: { _tag: 'Priced', usd: 12.5, unpricedTurns: 0 },
    outcomes: { useful: 5, wasted: 1, actionRequired: 1, open: 2, unrecorded: 0 },
    costPerUseful: 2.5,
    wastedShare: 0.1,
    breakEvenMinutes: 1,
    verdict: { _tag: 'Keep' },
    ...overrides,
  }
}

function report(kinds: PaybackKind[], overrides: Partial<PaybackReport> = {}): PaybackReport {
  return { ratesCheckedOn: '2026-11-17', hourlyValue: 150, kinds, ...overrides }
}

describe('payback rows', () => {
  it('shows dollars, merges out of settled work, and break-even minutes for a priced kind', () => {
    expect(paybackRows(report([kind({})]))).toEqual([{
      key: 'issue_work',
      work: 'issue_work',
      agentTurns: 10,
      cost: '$12.50',
      useful: '5 of 7',
      wasted: '10%',
      perUseful: '$2.50, 1 min',
      verdict: '',
      verdictTone: 'neutral',
      reason: null,
    }])
  })

  it('says under one minute instead of rounding a small break-even up', () => {
    const [row] = paybackRows(report([kind({ costPerUseful: 0.61, breakEvenMinutes: 0.24 })]))

    expect(row?.perUseful).toBe('$0.61, <1 min')
  })

  it('keeps the reason beside a verdict that asks for a change', () => {
    const [row] = paybackRows(report([kind({ work: 'conflict_resolution', wastedShare: 0.86, verdict: { _tag: 'Tune', reason: '86% of settled Agent turns produced nothing.' } })]))

    expect(row).toEqual(expect.objectContaining({ verdict: 'Tune', verdictTone: 'warning', reason: '86% of settled Agent turns produced nothing.' }))
  })

  it('says Unpriced and leaves per merge empty when no rate covers the model', () => {
    const [row] = paybackRows(report([kind({ cost: { _tag: 'Unpriced', models: ['glm-5.3'] }, costPerUseful: null, breakEvenMinutes: null })]))

    expect(row).toEqual(expect.objectContaining({ cost: 'Unpriced', perUseful: '' }))
  })

  it('names a Routine with the Routine chip and says its outcome is not recorded', () => {
    const [row] = paybackRows(report([kind({ work: 'routine', outcomes: { useful: 0, wasted: 0, actionRequired: 0, open: 0, unrecorded: 4 }, verdict: { _tag: 'MeasureFirst', reason: 'No useful outcome is recorded for this work yet.' } })]))

    expect(row).toEqual(expect.objectContaining({ work: 'routine_scan', useful: 'Not recorded', verdict: 'Measure first' }))
  })
})

describe('payback rates', () => {
  it('dates the rates and asks for an hourly value when none is set', () => {
    expect(paybackRatesText(report([], { hourlyValue: null }))).toBe('Rates checked 2026-11-17. Set an hourly value to see break-even minutes.')
    expect(paybackRatesText(report([], { ratesCheckedOn: null }))).toBe('No rates configured. Costs stay unpriced.')
  })
})
