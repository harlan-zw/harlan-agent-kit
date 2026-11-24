import type { Result } from './result.ts'
import type { RepairSource } from './store.ts'
import type { ReviewRun } from './types.ts'
import { err, ok } from './result.ts'

/**
 * The largest Repair delta a Review prompt carries.
 *
 * The delta rides in every Agent round trip, so a larger one costs more than
 * it saves. Repair deltas usually touch one to three files.
 */
export const REPAIR_DELTA_CHARACTER_BUDGET = 32_000

/** What Git reads between the head a Repair answered and the Repair commit. */
export type RepairDelta
  /** The answered head is not an ancestor: a rebase or force push. */
  = | { _tag: 'Rewritten' }
  /** A merge came in after the answered head, so the delta is not only Repair work. */
    | { _tag: 'IncludesMerge' }
  /** The delta is over the budget, so its text stays out of the prompt. */
    | { _tag: 'TooLarge', characters: number }
    | { _tag: 'Diff', diff: string, paths: readonly string[] }

/**
 * How much of the pull request one Review starts from.
 *
 * `Full` reads the whole base-to-head diff. `RepairFocus` starts from the
 * Repair delta, and the whole diff stays readable through `review_read`.
 */
export type ReviewScope
  = | { _tag: 'Full', reason: string }
    | { _tag: 'RepairFocus', source: ReviewRun, diff: string, paths: readonly string[] }

export interface RepairFocusSourceInput {
  /** A rerun or the manual Review label asks for a full Review whatever changed. */
  forced: boolean
  /** The Review a published Repair answered. Null for a head no Repair pushed. */
  repair: Pick<RepairSource, 'headSha' | 'builtOnHeadSha'> | null
  /** The latest current Review of an earlier head of this pull request. */
  earlier: ReviewRun | undefined
}

/**
 * The Review a Repair head can focus on, before Git reads the delta.
 *
 * The Repair must answer that Review and start from its head. That Review must
 * still be the current Review of an earlier head, so it shares this base branch
 * and repository policy and no later Review replaced it. The error is the
 * reason the Review reads the full diff.
 */
export function repairFocusSource(input: RepairFocusSourceInput): Result<ReviewRun, string> {
  if (input.forced)
    return err('A full Review was requested.')
  const repair = input.repair
  if (repair === null)
    return err('No Repair pushed this head.')
  if (repair.builtOnHeadSha !== repair.headSha)
    return err('The Repair started from a head its Review did not read.')
  if (input.earlier === undefined || input.earlier.headSha !== repair.headSha)
    return err('The Review the Repair answered is not the current Review of an earlier head.')
  return ok(input.earlier)
}

/** The scope of this Review once Git has read the Repair delta. Null means Git could not answer. */
export function repairFocusScope(source: ReviewRun, delta: RepairDelta | null): ReviewScope {
  if (delta === null)
    return { _tag: 'Full', reason: 'Git could not read the Repair delta.' }
  if (delta._tag === 'Rewritten')
    return { _tag: 'Full', reason: 'The answered head is not an ancestor of this head.' }
  if (delta._tag === 'IncludesMerge')
    return { _tag: 'Full', reason: 'A merge came in after the answered head.' }
  if (delta._tag === 'TooLarge')
    return { _tag: 'Full', reason: `The Repair delta has ${delta.characters} characters, over the ${REPAIR_DELTA_CHARACTER_BUDGET} budget.` }
  if (delta.diff.trim() === '' || delta.paths.length === 0)
    return { _tag: 'Full', reason: 'The Repair delta changes no file.' }
  return { _tag: 'RepairFocus', source, diff: delta.diff, paths: delta.paths }
}

/** The `Checked` clause of a focused Review, so the canonical comment says where it started. */
export function repairFocusCoverage(checked: string | null, sourceHeadSha: string): string {
  const focus = `focused on the Repair delta since ${sourceHeadSha.slice(0, 7)}, with the full diff available`
  const clause = checked?.trim().replace(/[.;,\s]+$/, '') ?? ''
  return clause === '' ? focus : `${clause}; ${focus}`
}
