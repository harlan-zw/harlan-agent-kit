import type { AgentEvent } from './agent-provider.ts'
import type { AgentProgress } from './types.ts'

export type AgentProgressWork = 'review' | 'issue' | 'conflict' | 'fix' | 'baseline' | 'routine'

/**
 * The phases one worker role passes through.
 *
 * - `Loaded`: the item is loaded and nothing has been prepared yet.
 * - `WorktreeReady`: the Git worktree exists, so the agent turn can start.
 * - `ReadingDiff`: the agent is reading the change.
 * - `CheckingDocs`: the agent is reading documentation off the repository.
 * - `Editing`: the agent is writing files.
 * - `Verifying`: the agent is running the repository's own checks.
 * - `Reported`: the agent named its own phase, so its words replace the guess.
 * - `Reporting`: the turn finished and the worker is assembling the result.
 * - `Checked`: the worker verified the result against the remote.
 * - `Committed`: the result is committed and ready to publish.
 *
 * The tag is the model and the rank comes from it, so no caller reads a phase
 * back out of a percentage. Two phases never share a rank, because a shared
 * rank froze the label: the comment kept saying `Running tests and checks`
 * while the agent had moved on to editing.
 */
export type AgentPhaseTag
  = | 'Loaded'
    | 'WorktreeReady'
    | 'ReadingDiff'
    | 'CheckingDocs'
    | 'Editing'
    | 'Verifying'
    | 'Reported'
    | 'Reporting'
    | 'Checked'
    | 'Committed'

/** One live phase. Structurally an `AgentProgress`, so the store keeps the parts it persists. */
export interface AgentPhase extends AgentProgress {
  _tag: AgentPhaseTag
}

/** Every phase whose rank is fixed. `Reported` carries the agent's own number instead. */
export type RankedPhaseTag = Exclude<AgentPhaseTag, 'Reported'>

const phaseRank: Record<RankedPhaseTag, number> = {
  Loaded: 10,
  WorktreeReady: 35,
  ReadingDiff: 45,
  CheckingDocs: 55,
  Editing: 65,
  Verifying: 75,
  Reporting: 85,
  Checked: 90,
  Committed: 95,
}

/**
 * The rank a worker reaches once it has a result.
 *
 * The queue reads this off a stored row, which keeps no phase tag, so the one
 * comparison against a rank lives here beside the ladder that sets it.
 */
export const RESULT_PHASE_RANK = phaseRank.Checked

/** The turn owns this band, so a self-reported percentage scales into it. */
const reportedFloor = phaseRank.WorktreeReady
const reportedCeiling = phaseRank.Reporting

/** A headline holds one short line, so a long self-reported phase is cut. */
const reportedLabelLimit = 72

const changedFilesLabel: Record<AgentProgressWork, string> = {
  review: 'Reviewing changed files',
  issue: 'Checking the issue against the code',
  conflict: 'Resolving merge conflicts',
  fix: 'Repairing review findings',
  baseline: 'Repairing the default branch',
  routine: 'Checking the repository',
}

const resultLabel: Record<AgentProgressWork, string> = {
  review: 'Preparing the review comment',
  issue: 'Preparing the issue triage result',
  conflict: 'Checking the conflict fix',
  fix: 'Checking the repair',
  baseline: 'Checking the default branch repair',
  routine: 'Preparing the Routine result',
}

/**
 * How long the current phase has run, in the fewest words that answer it.
 *
 * Empty under a minute, because a phase that just started says nothing useful
 * and every comment would carry noise.
 */
export function formatPhaseDuration(since: string | undefined, at: string): string {
  if (since === undefined)
    return ''
  const minutes = Math.floor((new Date(at).getTime() - new Date(since).getTime()) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1)
    return ''
  if (minutes < 60)
    return ` for ${minutes} min`
  const hours = Math.floor(minutes / 60)
  return ` for ${hours} h ${minutes - hours * 60} min`
}

/**
 * One phase a worker reached, with the line a reader sees.
 *
 * The label stays at the call site, because a checkpoint reads in the voice of
 * the worker that passed it and the tag carries everything a reader's next step
 * is derived from.
 */
export function agentPhase(tag: RankedPhaseTag, label: string): AgentPhase {
  return { _tag: tag, percent: phaseRank[tag], label }
}

/** Scales a self-reported percentage into the turn's band. */
function reportedPhase(percent: number, text: string): AgentPhase | undefined {
  const label = text.trim().slice(0, reportedLabelLimit)
  if (label === '')
    return undefined
  const clamped = Math.min(Math.max(percent, 0), 100)
  const scaled = reportedFloor + Math.round((clamped / 100) * (reportedCeiling - reportedFloor))
  return { _tag: 'Reported', percent: scaled, label }
}

/**
 * The phase one agent event puts the turn in.
 *
 * A self-reported phase wins, because the agent knows what it is doing and the
 * alternative is guessing from the shape of a shell command. `CommandCompleted`
 * says nothing `CommandStarted` did not already say, so only the start counts.
 */
export function agentEventPhase(event: AgentEvent, work: AgentProgressWork): AgentPhase | undefined {
  if (event._tag === 'Progress')
    return reportedPhase(event.percent, event.text)
  if (event._tag === 'WebSearch')
    return agentPhase('CheckingDocs', 'Checking docs')
  if (event._tag === 'CommandStarted') {
    const runsChecks = /(?:^|\s)(?:build|check|lint|test|typecheck|vitest)(?:\s|$|:)/i.test(event.command)
    return runsChecks
      ? agentPhase('Verifying', 'Running tests and checks')
      : agentPhase('ReadingDiff', changedFilesLabel[work])
  }
  if (event._tag === 'FileChanged')
    return agentPhase('Editing', 'Editing files')
  if (event._tag === 'TurnCompleted')
    return agentPhase('Reporting', resultLabel[work])
  return undefined
}

/**
 * The phase to report once the agent moved from `current` to `next`.
 *
 * An agent loops: it edits, runs the checks, then edits again. The label always
 * names what the agent is doing now, and the rank never goes backwards, so a
 * reader sees live work without the line appearing to regress.
 */
export function advancedPhase(current: AgentPhase, next: AgentPhase): AgentPhase | undefined {
  if (next._tag === current._tag && next.percent <= current.percent)
    return undefined
  return { ...next, percent: Math.max(current.percent, next.percent) }
}
