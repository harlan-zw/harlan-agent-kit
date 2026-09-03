import type { RepairRound } from './types.ts'
import { cleanLine } from './text.ts'

/**
 * How many consecutive controller Repairs one pull request head may carry.
 *
 * A Repair whose commit still fails Review used to stop the workflow after one
 * round. One round is too few: the second Repair Agent reads what the first one
 * tried and why Review rejected it, so it can choose a different fix. A cap
 * keeps the chain finite. A contributor commit ends the chain and starts a
 * fresh count.
 */
export const REPAIR_ROUND_LIMIT = 3

export type RepairRoundPlan
  = | { _tag: 'Allowed', number: number }
    | { _tag: 'Exhausted', reason: string }

export function repairRoundLabel(rounds: { number: number, limit: number }): string {
  return `round ${rounds.number} of ${rounds.limit}`
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function roundLine(round: RepairRound): string {
  const report = round.summary === null ? 'no Repair report' : cleanLine(round.summary)
  return `Round ${round.number} (\`${shortSha(round.commitSha)}\`): ${report}`
}

/**
 * Decides whether one more Repair may start on a head produced by prior rounds.
 *
 * Pure: the store reads the lineage, this function only judges it.
 */
export function planRepairRound(prior: RepairRound[], limit: number = REPAIR_ROUND_LIMIT): RepairRoundPlan {
  const number = prior.length + 1
  if (number <= limit)
    return { _tag: 'Allowed', number }
  const history = prior.map(roundLine).join(' ')
  return {
    _tag: 'Exhausted',
    reason: `Repair used ${prior.length} of ${limit} rounds and the finding remains. ${history} A person decides the next step.`,
  }
}

/**
 * The history one Repair Agent reads before it starts a later round.
 *
 * It names every prior commit, what that Repair reported, and what it targeted,
 * so the Agent can rule out an approach that Review already rejected.
 */
export function repairRoundHistory(rounds: { number: number, limit: number, prior: RepairRound[] }): string {
  if (rounds.prior.length === 0)
    return ''
  const lines = rounds.prior.map(round => [
    `Round ${round.number} published commit ${round.commitSha}.`,
    `It targeted: ${round.findings.map(cleanLine).join(' | ')}`,
    `Its Repair Agent reported: ${round.summary === null ? 'no report' : cleanLine(round.summary)}`,
    ...(round.checks.length === 0 ? [] : [`It ran: ${round.checks.map(cleanLine).join('; ')}`]),
  ].join('\n'))
  return `
This is Repair ${repairRoundLabel(rounds)}. Earlier rounds on this pull request already published commits, and a fresh Review still found the defects below.
${lines.join('\n\n')}

Read each earlier commit with git show before you change anything.
Treat every earlier approach as rejected. Choose a different fix that answers the current proof.
Do not revert an earlier round unless its change caused the current finding.`
}
