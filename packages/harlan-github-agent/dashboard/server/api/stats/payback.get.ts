import type { PaybackReport } from '../../../../src/payback.ts'
import { createError, defineEventHandler, getQuery } from 'h3'
import { parseStatsRange } from '../../../../src/stats.ts'
import { assertDevMock } from '../../utils/mock.ts'

/**
 * A dev-only stand-in for `/api/stats/payback`, shaped like the 30 days
 * before 17 November 2026, so every verdict renders.
 */
export default defineEventHandler((event): PaybackReport => {
  assertDevMock(event)
  const query = getQuery(event)
  const range = parseStatsRange({
    from: typeof query.from === 'string' ? query.from : undefined,
    to: typeof query.to === 'string' ? query.to : undefined,
    timeZone: typeof query.time_zone === 'string' ? query.time_zone : undefined,
  })
  if (range._tag === 'Err')
    throw createError({ status: 400, statusText: 'Bad Request', message: 'The Stats range is invalid.' })
  const tokens = (input: number, output: number) => ({ input, cachedInput: Math.round(input * 0.92), cacheWrite: 0, output, reasoning: 0 })
  return {
    ratesCheckedOn: '2026-11-17',
    hourlyValue: 150,
    kinds: [
      { work: 'issue_work', agentTurns: 120, failedTurns: 3, turnsWithoutUsage: 0, tokens: tokens(194_000_000, 1_250_000), cost: { _tag: 'Priced', usd: 46, unpricedTurns: 49 }, outcomes: { useful: 76, wasted: 0, actionRequired: 0, open: 31, unrecorded: 0 }, costPerUseful: 0.61, wastedShare: 0.08, breakEvenMinutes: 0.24, verdict: { _tag: 'Keep' } },
      { work: 'review_fix', agentTurns: 106, failedTurns: 2, turnsWithoutUsage: 0, tokens: tokens(161_000_000, 630_000), cost: { _tag: 'Priced', usd: 36, unpricedTurns: 0 }, outcomes: { useful: 52, wasted: 9, actionRequired: 0, open: 28, unrecorded: 0 }, costPerUseful: 0.69, wastedShare: 0.15, breakEvenMinutes: 0.28, verdict: { _tag: 'Keep' } },
      { work: 'conflict_resolution', agentTurns: 981, failedTurns: 15, turnsWithoutUsage: 0, tokens: tokens(500_000_000, 1_670_000), cost: { _tag: 'Priced', usd: 144, unpricedTurns: 0 }, outcomes: { useful: 35, wasted: 150, actionRequired: 0, open: 29, unrecorded: 0 }, costPerUseful: 4.11, wastedShare: 0.86, breakEvenMinutes: 1.64, verdict: { _tag: 'Tune', reason: '86% of Agent turns went to work that produced nothing or needs Action required.' } },
      { work: 'adversarial_review', agentTurns: 1_427, failedTurns: 1, turnsWithoutUsage: 0, tokens: tokens(2_297_000_000, 4_390_000), cost: { _tag: 'Priced', usd: 481, unpricedTurns: 20 }, outcomes: { useful: 0, wasted: 0, actionRequired: 0, open: 0, unrecorded: 1_427 }, costPerUseful: null, wastedShare: null, breakEvenMinutes: null, verdict: { _tag: 'MeasureFirst', reason: 'No useful outcome is recorded for most of this work yet.' } },
    ],
  }
})
