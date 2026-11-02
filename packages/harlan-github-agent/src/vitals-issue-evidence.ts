import type { RoutineIssueSource } from './types.ts'
import type { VitalsComparisonTarget } from './vitals-comparison.ts'

export type VitalsIssueEvidence
  = | { _tag: 'NotRequired' }
    | { _tag: 'Required', targets: VitalsComparisonTarget[] }
    | { _tag: 'Unavailable', reason: string }

/** Only Published candidate data may choose the metric that must improve. Issue text cannot grant or change it. */
export function vitalsIssueEvidence(sources: readonly (RoutineIssueSource | null)[]): VitalsIssueEvidence {
  const targets: VitalsComparisonTarget[] = []
  for (const source of sources) {
    if (source?.routineName !== 'vitals-review')
      continue
    const lab = /^vitals-lab#(\/[^#]*)#(mobile|desktop)#(lcp|fcp|tbt|cls)$/.exec(source.fingerprint)
    const field = /^vitals-field#(\/[^#]*)#(lcp|inp|cls)#.+$/.exec(source.fingerprint)
    // This suffix is written by the controller after the untrusted claim.
    // An earlier "skip" instruction in the proposed claim grants no exception.
    const fieldOnly = /(?:^|\n\n)Skip lab verification: lab CLS is (unmeasured|\d+(?:\.\d+)?) while field CLS is poor, so the shift happens only during real interaction\. Confirm from field data after deploy\.$/.exec(source.claim)
    const fieldOnlyCls = fieldOnly !== null && (fieldOnly[1] === 'unmeasured' || Number(fieldOnly[1]) < 0.1)
    if (field !== null && (field[2] === 'inp' || (field[2] === 'cls' && fieldOnlyCls)))
      continue
    const target = lab !== null
      ? { path: lab[1], strategy: lab[2], metric: lab[3] }
      : field !== null && (field[2] === 'lcp' || field[2] === 'cls')
        ? { path: field[1], strategy: 'mobile', metric: field[2] }
        : null
    if (target === null)
      return { _tag: 'Unavailable', reason: 'The Published vitals proposal has no supported performance evidence target.' }
    if (!targets.some(value => value.path === target.path && value.strategy === target.strategy && value.metric === target.metric))
      targets.push(target as VitalsComparisonTarget)
  }
  return targets.length === 0
    ? { _tag: 'NotRequired' }
    : targets.length > 8
      ? { _tag: 'Unavailable', reason: 'Split this vitals work into groups of eight measured targets or fewer.' }
      : { _tag: 'Required', targets }
}
