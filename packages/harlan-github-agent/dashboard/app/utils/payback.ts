import type { PaybackKind, PaybackReport, PaybackVerdict } from '../../../src/payback.ts'
import type { WorkKey } from './dashboard.ts'

/**
 * Pure presentation for the Payback table. Every label and number the row
 * shows comes from here, so it can be tested without rendering.
 */

export interface PaybackRow {
  key: string
  work: WorkKey
  agentTurns: number
  cost: string
  useful: string
  wasted: string
  perUseful: string
  verdict: string
  verdictTone: 'neutral' | 'warning' | 'error'
  reason: string | null
}

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

function workKey(kind: PaybackKind): WorkKey {
  return kind.work === 'routine' ? 'routine_scan' : kind.work
}

function costText(kind: PaybackKind): string {
  if (kind.cost._tag === 'Unpriced')
    return 'Unpriced'
  return kind.cost.unpricedTurns > 0
    ? `${dollars.format(kind.cost.usd)} + ${kind.cost.unpricedTurns} unpriced`
    : dollars.format(kind.cost.usd)
}

function usefulText(kind: PaybackKind): string {
  const settled = kind.outcomes.useful + kind.outcomes.wasted
  if (settled === 0)
    return kind.outcomes.open > 0 ? `${kind.outcomes.open} open` : 'Not recorded'
  return `${kind.outcomes.useful} of ${settled}`
}

function perUsefulText(kind: PaybackKind): string {
  if (kind.costPerUseful === null)
    return ''
  const perUseful = dollars.format(kind.costPerUseful)
  return kind.breakEvenMinutes === null ? perUseful : `${perUseful}, ${Math.max(1, Math.round(kind.breakEvenMinutes))} min`
}

const verdictLabels: Record<PaybackVerdict['_tag'], string> = {
  Keep: 'Keep',
  Tune: 'Tune',
  Cut: 'Cut',
  MeasureFirst: 'Measure first',
}

function verdictTone(verdict: PaybackVerdict): PaybackRow['verdictTone'] {
  if (verdict._tag === 'Cut')
    return 'error'
  if (verdict._tag === 'Tune')
    return 'warning'
  return 'neutral'
}

export function paybackRows(report: PaybackReport): PaybackRow[] {
  return report.kinds.map(kind => ({
    key: kind.work,
    work: workKey(kind),
    agentTurns: kind.agentTurns,
    cost: costText(kind),
    useful: usefulText(kind),
    wasted: kind.wastedShare === null ? '' : `${Math.round(kind.wastedShare * 100)}%`,
    perUseful: perUsefulText(kind),
    verdict: verdictLabels[kind.verdict._tag],
    verdictTone: verdictTone(kind.verdict),
    reason: kind.verdict._tag === 'Keep' ? null : kind.verdict.reason,
  }))
}

/** Where the dollars come from, so nobody reads a stale rate as current. */
export function paybackRatesText(report: PaybackReport): string {
  if (report.ratesCheckedOn === null)
    return 'No rates configured. Costs stay unpriced.'
  const hourly = report.hourlyValue === null ? ' Set an hourly value to see break-even minutes.' : ''
  return `Rates checked ${report.ratesCheckedOn}.${hourly}`
}
