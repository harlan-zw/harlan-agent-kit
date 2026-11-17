import type { AgentTokenUsage } from './agent-provider.ts'
import type { AgentTurnRecord } from './agent-turn-store.ts'
import type { AgentRole } from './types.ts'

/** The work Payback reports on: one Task kind, Review runs, Issue triage, Routines, or Batch planning. */
export type PaybackWork = 'issue_work' | 'review_fix' | 'baseline_repair' | 'conflict_resolution' | 'adversarial_review' | 'issue_triage' | 'routine' | 'batch_plan'

const PAYBACK_WORK: readonly PaybackWork[] = ['issue_work', 'review_fix', 'baseline_repair', 'conflict_resolution', 'adversarial_review', 'issue_triage', 'routine', 'batch_plan']

export function paybackWork(role: AgentRole): PaybackWork {
  if (role === 'routine_scan' || role === 'routine_fix')
    return 'routine'
  return role
}

/** US dollars per million tokens for one model, on the date the rates were checked. */
export interface PaybackRate {
  input: number
  cachedInput: number
  cacheWrite: number
  output: number
}

export interface PaybackPricing {
  rates: Readonly<Record<string, PaybackRate>>
  /** When someone last checked the rates against the provider's price page. */
  ratesCheckedOn: string | null
  /** What one hour of Harlan's time is worth in US dollars, or null when unset. */
  hourlyValue: number | null
}

/** What the Journal says one Task's pull request became. */
export type PaybackPullRequest = 'Merged' | 'Closed' | 'Open' | 'None'

/** One Task, Review run, Routine run, or Batch that spent an Agent turn in the range. */
export interface PaybackTaskFact {
  taskId: string
  /** The Task state, or null when the id names a Review run, Routine run, or Batch. */
  state: 'Queued' | 'ActionRequired' | 'Running' | 'Publishing' | 'Completed' | 'Failed' | 'Superseded' | null
  published: boolean
  pullRequest: PaybackPullRequest
}

/** What one unit of work produced, as far as the Journal can tell. */
export type PaybackOutcome
  = | { _tag: 'Useful' }
    | { _tag: 'Wasted', reason: 'ClosedUnmerged' | 'NothingPublished' }
    | { _tag: 'Open' }
    /** The Journal records no useful outcome for this kind of work yet. */
    | { _tag: 'Unrecorded' }

export function paybackOutcome(fact: PaybackTaskFact): PaybackOutcome {
  if (fact.state === null)
    return { _tag: 'Unrecorded' }
  if (fact.published) {
    if (fact.pullRequest === 'Merged')
      return { _tag: 'Useful' }
    if (fact.pullRequest === 'Closed')
      return { _tag: 'Wasted', reason: 'ClosedUnmerged' }
    return { _tag: 'Open' }
  }
  if (fact.state === 'Completed' || fact.state === 'Failed' || fact.state === 'Superseded')
    return { _tag: 'Wasted', reason: 'NothingPublished' }
  return { _tag: 'Open' }
}

export type PaybackCost
  = | { _tag: 'Priced', usd: number, unpricedTurns: number }
    | { _tag: 'Unpriced', models: string[] }

export type PaybackVerdict
  = | { _tag: 'Keep' }
    | { _tag: 'Tune', reason: string }
    | { _tag: 'Cut', reason: string }
    | { _tag: 'MeasureFirst', reason: string }

export interface PaybackTokens {
  input: number
  cachedInput: number
  cacheWrite: number
  output: number
  reasoning: number
}

export interface PaybackKind {
  work: PaybackWork
  agentTurns: number
  failedTurns: number
  /** Agent turns whose provider reported no usage. Their tokens are missing from `tokens`. */
  turnsWithoutUsage: number
  tokens: PaybackTokens
  cost: PaybackCost
  outcomes: { useful: number, wasted: number, open: number, unrecorded: number }
  /** Dollars per useful outcome, or null when nothing was useful or the cost is unpriced. */
  costPerUseful: number | null
  /** Share of Agent turns on settled work that went to work with nothing to show. */
  wastedShare: number | null
  /** Minutes of Harlan's time each useful outcome must save to pay for itself. */
  breakEvenMinutes: number | null
  verdict: PaybackVerdict
}

export interface PaybackReport {
  ratesCheckedOn: string | null
  hourlyValue: number | null
  kinds: PaybackKind[]
}

/** Above this share of settled Agent turns producing nothing, the work needs tuning. */
const TUNE_WASTED_SHARE = 0.5

const emptyTokens = (): PaybackTokens => ({ input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 })

/**
 * Dollars one turn cost at its model's rate. Codex counts reasoning inside
 * output, and `input` holds every input token, so fresh input is the remainder.
 */
function turnUsd(usage: Extract<AgentTokenUsage, { _tag: 'Available' }>, rate: PaybackRate): number {
  const fresh = Math.max(0, usage.input - usage.cachedInput - usage.cacheWrite)
  return (fresh * rate.input + usage.cachedInput * rate.cachedInput + usage.cacheWrite * rate.cacheWrite + usage.output * rate.output) / 1_000_000
}

function verdict(work: PaybackWork, outcomes: PaybackKind['outcomes'], wastedShare: number | null, spent: boolean): PaybackVerdict {
  if (outcomes.unrecorded > 0 && outcomes.useful + outcomes.wasted + outcomes.open === 0)
    return { _tag: 'MeasureFirst', reason: `The Journal records no useful outcome for ${work} yet.` }
  if (outcomes.useful + outcomes.wasted === 0)
    return { _tag: 'MeasureFirst', reason: 'No work settled in this range.' }
  if (outcomes.useful === 0 && spent)
    return { _tag: 'Cut', reason: `${outcomes.wasted} settled, none useful.` }
  if (wastedShare !== null && wastedShare > TUNE_WASTED_SHARE)
    return { _tag: 'Tune', reason: `${Math.round(wastedShare * 100)}% of settled Agent turns produced nothing.` }
  return { _tag: 'Keep' }
}

/**
 * What each kind of work cost and what it produced.
 *
 * Every number is measured except dollars, which come from dated rates, and
 * break-even minutes, which also need Harlan's hourly value.
 */
export function buildPayback(input: { turns: readonly AgentTurnRecord[], tasks: readonly PaybackTaskFact[], pricing: PaybackPricing }): PaybackReport {
  const outcomeByTask = new Map(input.tasks.map(fact => [fact.taskId, paybackOutcome(fact)]))
  const turnsByWork = Map.groupBy(input.turns, turn => paybackWork(turn.role))
  const kinds = PAYBACK_WORK.flatMap((work): PaybackKind[] => {
    const turns = turnsByWork.get(work) ?? []
    if (turns.length === 0)
      return []
    const tokens = emptyTokens()
    let usd = 0
    let pricedTurns = 0
    let unpricedTurns = 0
    const unpricedModels = new Set<string>()
    for (const turn of turns) {
      if (turn.usage._tag === 'Unavailable')
        continue
      tokens.input += turn.usage.input
      tokens.cachedInput += turn.usage.cachedInput
      tokens.cacheWrite += turn.usage.cacheWrite
      tokens.output += turn.usage.output
      tokens.reasoning += turn.usage.reasoning
      const rate = input.pricing.rates[turn.model]
      if (rate === undefined) {
        unpricedTurns += 1
        unpricedModels.add(turn.model)
      }
      else {
        pricedTurns += 1
        usd += turnUsd(turn.usage, rate)
      }
    }
    const cost: PaybackCost = pricedTurns > 0
      ? { _tag: 'Priced', usd, unpricedTurns }
      : { _tag: 'Unpriced', models: [...unpricedModels].sort() }

    const taskIds = [...new Set(turns.map(turn => turn.taskId))]
    const outcomes = { useful: 0, wasted: 0, open: 0, unrecorded: 0 }
    for (const taskId of taskIds) {
      const outcome = outcomeByTask.get(taskId) ?? { _tag: 'Unrecorded' as const }
      if (outcome._tag === 'Useful')
        outcomes.useful += 1
      else if (outcome._tag === 'Wasted')
        outcomes.wasted += 1
      else if (outcome._tag === 'Open')
        outcomes.open += 1
      else
        outcomes.unrecorded += 1
    }
    const settledTurns = turns.filter(turn => ['Useful', 'Wasted'].includes(outcomeByTask.get(turn.taskId)?._tag ?? ''))
    const wastedTurns = settledTurns.filter(turn => outcomeByTask.get(turn.taskId)?._tag === 'Wasted')
    const wastedShare = settledTurns.length === 0 ? null : wastedTurns.length / settledTurns.length
    const costPerUseful = cost._tag === 'Priced' && outcomes.useful > 0 ? cost.usd / outcomes.useful : null
    const breakEvenMinutes = costPerUseful !== null && input.pricing.hourlyValue !== null && input.pricing.hourlyValue > 0
      ? costPerUseful / input.pricing.hourlyValue * 60
      : null
    const spent = turns.some(turn => turn.usage._tag === 'Available' && turn.usage.input + turn.usage.output > 0)
    return [{
      work,
      agentTurns: turns.length,
      failedTurns: turns.filter(turn => turn.outcome === 'Failed').length,
      turnsWithoutUsage: turns.filter(turn => turn.usage._tag === 'Unavailable').length,
      tokens,
      cost,
      outcomes,
      costPerUseful,
      wastedShare,
      breakEvenMinutes,
      verdict: verdict(work, outcomes, wastedShare, spent),
    }]
  })
  return { ratesCheckedOn: input.pricing.ratesCheckedOn, hourlyValue: input.pricing.hourlyValue, kinds }
}
