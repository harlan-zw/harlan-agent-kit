import type { AgentTokenUsage } from './agent-provider.ts'
import type { AgentTurnRecord } from './agent-turn-store.ts'
import type { RoutineName } from './routines/index.ts'
import type { AgentRole, RoutineMode, RoutineRunState } from './types.ts'

type RoutineRole = Extract<AgentRole, 'routine_scan' | 'routine_fix'>

/** Every Agent role except a Routine's. Payback splits Routine turns by Routine instead. */
export type PaybackRole = Exclude<AgentRole, RoutineRole>

/**
 * The work one Payback row reports on: one Agent role, or one Routine.
 * Each Routine gets its own row, because a trial switches one Routine at a time.
 */
export type PaybackWork
  = | { _tag: 'Role', role: PaybackRole }
    | { _tag: 'Routine', name: RoutineName }
    /** Routine turns whose run names no Routine this service defines. */
    | { _tag: 'UnnamedRoutine' }

// A Record, so a new Agent role is a type error here until it has a place.
const ROLE_RANK: Record<PaybackRole, number> = { issue_work: 0, review_fix: 1, baseline_repair: 2, conflict_resolution: 3, adversarial_review: 4, issue_triage: 5, batch_plan: 6 }
const ROUTINE_RANK = Object.keys(ROLE_RANK).length

function isRoutineRole(role: AgentRole): role is RoutineRole {
  return role === 'routine_scan' || role === 'routine_fix'
}

/** Groups turns by work. Never shown, so it only has to be unique. */
function workKey(work: PaybackWork): string {
  switch (work._tag) {
    case 'Role': return `role:${work.role}`
    case 'Routine': return `routine:${work.name}`
    case 'UnnamedRoutine': return 'routine'
  }
}

/** Roles in a fixed order, then Routines by name, then turns no Routine claims. */
function compareWork(left: PaybackWork, right: PaybackWork): number {
  const rank = (work: PaybackWork) => work._tag === 'Role' ? ROLE_RANK[work.role] : work._tag === 'Routine' ? ROUTINE_RANK : ROUTINE_RANK + 1
  const byRank = rank(left) - rank(right)
  if (byRank !== 0 || left._tag !== 'Routine' || right._tag !== 'Routine')
    return byRank
  return left.name.localeCompare(right.name)
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

/** Candidates one Routine run recorded, counted by what became of them. */
export interface PaybackCandidates {
  merged: number
  /** Still Proposed: the issue is open, or its pull request has not merged yet. */
  open: number
  /** Rejected or Superseded: the issue closed with no merged fix. */
  closed: number
}

/** One Routine run that spent an Agent turn in the range, and what its Candidates became. */
export interface PaybackRoutineRunFact {
  runId: string
  work: Extract<PaybackWork, { _tag: 'Routine' | 'UnnamedRoutine' }>
  mode: RoutineMode
  state: RoutineRunState['_tag']
  candidates: PaybackCandidates
}

/** What one unit of work produced, as far as the Journal can tell. */
export type PaybackOutcome
  = | { _tag: 'Useful' }
    | { _tag: 'Wasted', reason: 'ClosedUnmerged' | 'NothingPublished' | 'NothingProposed' }
    /** A Routine run that completed and filed no Candidate. Its spend counts, but it is neither useful nor wasted. */
    | { _tag: 'Quiet' }
    | { _tag: 'Open' }
    /** Stopped on a blocker only a person can clear. It spent turns and has nothing to show yet. */
    | { _tag: 'ActionRequired' }
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
  if (fact.state === 'ActionRequired')
    return { _tag: 'ActionRequired' }
  return { _tag: 'Open' }
}

/**
 * A Routine run is useful when one of its Candidates merged. A completed run
 * that filed none is Quiet: a monitor on a healthy site. A failed scan is
 * Wasted. A report run files no issue, so its outcome is not recorded.
 */
export function paybackRoutineRunOutcome(fact: PaybackRoutineRunFact): PaybackOutcome {
  if (fact.mode === 'report')
    return { _tag: 'Unrecorded' }
  if (fact.candidates.merged > 0)
    return { _tag: 'Useful' }
  if (fact.candidates.open > 0)
    return { _tag: 'Open' }
  if (fact.candidates.closed > 0)
    return { _tag: 'Wasted', reason: 'ClosedUnmerged' }
  switch (fact.state) {
    case 'Completed':
      return { _tag: 'Quiet' }
    case 'Failed':
    case 'Skipped':
    case 'Superseded':
      return { _tag: 'Wasted', reason: 'NothingProposed' }
    case 'ActionRequired':
      return { _tag: 'ActionRequired' }
    case 'Queued':
    case 'Running':
      return { _tag: 'Open' }
  }
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
  /** `quiet` counts Quiet Routine runs. It is always zero for other work. */
  outcomes: { useful: number, wasted: number, actionRequired: number, open: number, quiet: number, unrecorded: number }
  /** Dollars per useful outcome, or null when nothing was useful or the cost is unpriced. */
  costPerUseful: number | null
  /** Share of Agent turns on settled or blocked work that went to work with nothing to show. Quiet runs are left out. */
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

/** Above this share of settled or blocked Agent turns producing nothing, the work needs tuning. */
const TUNE_WASTED_SHARE = 0.5

/** Above this share of Agent turns with no recorded outcome, no verdict is honest. */
const MEASURE_FIRST_UNRECORDED_SHARE = 0.5

const emptyTokens = (): PaybackTokens => ({ input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 })

/**
 * Dollars one turn cost at its model's rate. Codex counts reasoning inside
 * output, and `input` holds every input token, so fresh input is the remainder.
 */
function turnUsd(usage: Extract<AgentTokenUsage, { _tag: 'Available' }>, rate: PaybackRate): number {
  const fresh = Math.max(0, usage.input - usage.cachedInput - usage.cacheWrite)
  return (fresh * rate.input + usage.cachedInput * rate.cachedInput + usage.cacheWrite * rate.cacheWrite + usage.output * rate.output) / 1_000_000
}

function verdict(work: PaybackWork, outcomes: PaybackKind['outcomes'], unrecordedShare: number, wastedShare: number | null, spent: boolean): PaybackVerdict {
  if (unrecordedShare > MEASURE_FIRST_UNRECORDED_SHARE)
    return { _tag: 'MeasureFirst', reason: 'No useful outcome is recorded for most of this work yet.' }
  if (outcomes.useful + outcomes.wasted + outcomes.actionRequired + outcomes.quiet === 0)
    return { _tag: 'MeasureFirst', reason: 'No work settled in this range.' }
  if (work._tag !== 'Role')
    return routineVerdict(outcomes, wastedShare, spent)
  if (outcomes.useful === 0 && outcomes.wasted > 0 && spent)
    return { _tag: 'Cut', reason: `${outcomes.wasted} settled, none useful.` }
  if (wastedShare !== null && wastedShare > TUNE_WASTED_SHARE)
    return { _tag: 'Tune', reason: `${Math.round(wastedShare * 100)}% of Agent turns went to work that produced nothing or needs Action required.` }
  return { _tag: 'Keep' }
}

/** A Routine pays for its Quiet runs, but only closed proposals, failed scans, and blockers count as wasted. */
function routineVerdict(outcomes: PaybackKind['outcomes'], wastedShare: number | null, spent: boolean): PaybackVerdict {
  const runs = outcomes.quiet + outcomes.wasted
  if (outcomes.useful === 0 && runs > 0 && spent)
    return { _tag: 'Cut', reason: `${runs} ${runs === 1 ? 'run' : 'runs'}, no merged proposal.` }
  if (wastedShare !== null && wastedShare > TUNE_WASTED_SHARE)
    return { _tag: 'Tune', reason: `${Math.round(wastedShare * 100)}% of settled Agent turns went to closed proposals, failed scans, or Action required.` }
  return { _tag: 'Keep' }
}

/**
 * What each kind of work cost and what it produced.
 *
 * Every number is measured except dollars, which come from dated rates, and
 * break-even minutes, which also need Harlan's hourly value.
 */
export function buildPayback(input: { turns: readonly AgentTurnRecord[], tasks: readonly PaybackTaskFact[], routineRuns: readonly PaybackRoutineRunFact[], pricing: PaybackPricing }): PaybackReport {
  const outcomeByTask = new Map(input.tasks.map(fact => [fact.taskId, paybackOutcome(fact)]))
  const routineRunById = new Map(input.routineRuns.map(fact => [fact.runId, { work: fact.work, outcome: paybackRoutineRunOutcome(fact) }]))
  // The Task facts also list Routine run ids, with no state, so a Routine turn reads only its run.
  const workOf = (turn: AgentTurnRecord): PaybackWork => isRoutineRole(turn.role)
    ? routineRunById.get(turn.taskId)?.work ?? { _tag: 'UnnamedRoutine' }
    : { _tag: 'Role', role: turn.role }
  const outcomeOf = (turn: AgentTurnRecord): PaybackOutcome['_tag'] => (isRoutineRole(turn.role)
    ? routineRunById.get(turn.taskId)?.outcome
    : outcomeByTask.get(turn.taskId))?._tag ?? 'Unrecorded'

  const groups = new Map<string, { work: PaybackWork, turns: AgentTurnRecord[] }>()
  for (const turn of input.turns) {
    const work = workOf(turn)
    const group = groups.get(workKey(work))
    if (group === undefined)
      groups.set(workKey(work), { work, turns: [turn] })
    else
      group.turns.push(turn)
  }
  const kinds = [...groups.values()].sort((left, right) => compareWork(left.work, right.work)).map(({ work, turns }): PaybackKind => {
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

    const turnByTask = new Map(turns.map(turn => [turn.taskId, turn]))
    const outcomes = { useful: 0, wasted: 0, actionRequired: 0, open: 0, quiet: 0, unrecorded: 0 }
    for (const turn of turnByTask.values()) {
      const outcome = outcomeOf(turn)
      if (outcome === 'Useful')
        outcomes.useful += 1
      else if (outcome === 'Wasted')
        outcomes.wasted += 1
      else if (outcome === 'ActionRequired')
        outcomes.actionRequired += 1
      else if (outcome === 'Open')
        outcomes.open += 1
      else if (outcome === 'Quiet')
        outcomes.quiet += 1
      else
        outcomes.unrecorded += 1
    }
    const settledTurns = turns.filter(turn => ['Useful', 'Wasted', 'ActionRequired'].includes(outcomeOf(turn)))
    const wastedTurns = settledTurns.filter(turn => outcomeOf(turn) !== 'Useful')
    const wastedShare = settledTurns.length === 0 ? null : wastedTurns.length / settledTurns.length
    const unrecordedShare = turns.filter(turn => outcomeOf(turn) === 'Unrecorded').length / turns.length
    const costPerUseful = cost._tag === 'Priced' && outcomes.useful > 0 ? cost.usd / outcomes.useful : null
    const breakEvenMinutes = costPerUseful !== null && input.pricing.hourlyValue !== null && input.pricing.hourlyValue > 0
      ? costPerUseful / input.pricing.hourlyValue * 60
      : null
    const spent = turns.some(turn => turn.usage._tag === 'Available' && turn.usage.input + turn.usage.output > 0)
    return {
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
      verdict: verdict(work, outcomes, unrecordedShare, wastedShare, spent),
    }
  })
  return { ratesCheckedOn: input.pricing.ratesCheckedOn, hourlyValue: input.pricing.hourlyValue, kinds }
}
