import type { PaybackKind, PaybackReport, PaybackVerdict, PaybackWork } from '../../../src/payback.ts'
import type { WorkKey } from './dashboard.ts'

/**
 * Pure presentation for the Payback table. Every label and number the row
 * shows comes from here, so it can be tested without rendering.
 */

export interface PaybackRow {
  key: string
  work: WorkKey
  /** The Routine this row reports on, printed beside its chip. */
  routine: string | null
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

function workKey(work: PaybackWork): WorkKey {
  return work._tag === 'Role' ? work.role : 'routine_scan'
}

function rowKey(work: PaybackWork): string {
  switch (work._tag) {
    case 'Role': return work.role
    case 'Routine': return `routine:${work.name}`
    case 'UnnamedRoutine': return 'routine'
  }
}

function costText(kind: PaybackKind): string {
  if (kind.cost._tag === 'Unpriced')
    return 'Unpriced'
  return kind.cost.unpricedTurns > 0
    ? `${dollars.format(kind.cost.usd)} + ${kind.cost.unpricedTurns} unpriced`
    : dollars.format(kind.cost.usd)
}

function usefulText(kind: PaybackKind): string {
  const settled = kind.outcomes.useful + kind.outcomes.wasted + kind.outcomes.actionRequired
  if (settled === 0)
    return kind.outcomes.open > 0 ? `${kind.outcomes.open} open` : 'Not recorded'
  return `${kind.outcomes.useful} of ${settled}`
}

function perUsefulText(kind: PaybackKind): string {
  if (kind.costPerUseful === null)
    return ''
  const perUseful = dollars.format(kind.costPerUseful)
  if (kind.breakEvenMinutes === null)
    return perUseful
  return kind.breakEvenMinutes < 1 ? `${perUseful}, <1 min` : `${perUseful}, ${Math.round(kind.breakEvenMinutes)} min`
}

/** Keep is the normal case, so its cell stays empty and the exceptions stand out. */
const verdictLabels: Record<PaybackVerdict['_tag'], string> = {
  Keep: '',
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
    key: rowKey(kind.work),
    work: workKey(kind.work),
    routine: kind.work._tag === 'Routine' ? kind.work.name : null,
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
