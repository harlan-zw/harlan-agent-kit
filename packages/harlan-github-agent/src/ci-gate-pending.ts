/**
 * How long a CI Review gate may read PENDING before a person must look at it.
 *
 * The controller waits for CI correctly and reports nothing while it waits, so
 * a repository whose CI never starts reads exactly like one whose CI is slow.
 * On 2026-09-05 one repository ran no check run for ten hours, and two pull
 * requests held a red base branch for a day. Nothing named either, so Harlan
 * found both by asking.
 *
 * This module decides only whether one gate is overdue. It starts nothing,
 * cancels nothing, and re-runs nothing. The Incident it feeds is the whole
 * output, and Harlan decides what to do about it.
 */
import type { ReviewGates } from './types.ts'
import { updatedAtLabel } from './text.ts'

/**
 * Why one CI Review gate has not settled, read from the live check sets.
 *
 * The gate itself carries prose, and prose cannot be classified without
 * matching strings the controller wrote. The cause therefore travels beside
 * the gate, from the same branch that decided it.
 */
export type CiGateCause
  /** The gate reached a verdict, so nothing is outstanding. */
  = | { _tag: 'Settled' }
    /** The base branch is broken, so no head check run can clear the gate. */
    | { _tag: 'BaseBranchFailed', check: string }
    /** GitHub owes a check run it has never reported. */
    | { _tag: 'NoCheckRun', detail: string }
    /** A check run started and has not reported a conclusion. */
    | { _tag: 'CheckRunning', check: string }
    /** A check run is queued, so no runner has accepted its job. */
    | { _tag: 'CheckQueued', check: string }
    /** The controller could not read the check runs at all. */
    | { _tag: 'ChecksUnreadable', reason: string }
    /** A runner stopped mid job. `runner_lost` already names this one. */
    | { _tag: 'RunnerLost', check: string }

/**
 * How long a check run with no conclusion may hold the gate.
 *
 * GitHub stops any Actions job after six hours. Past that limit GitHub itself
 * has killed the job, so a check run that still reports no conclusion will
 * never report one. The bound is GitHub's own, not a number picked to feel
 * right, and it never fires while a job could still finish.
 *
 * A queued job shares the bound for a different reason. The runner supervisor
 * on Hogwild drops a queued run older than six hours, so past that no runner
 * will ever take the job, and a re-run keeps the run's creation time.
 */
export const RUNNING_CHECK_BOUND_MILLISECONDS = 6 * 60 * 60_000

/**
 * How long a gate with nothing in flight may read PENDING.
 *
 * Nothing runs in these causes, so only a person or a later push changes them.
 * The longest healthy PENDING this service ever recorded is three hours, on
 * 2026-08-27, when a base branch deploy was still running after a Review
 * finished. Four hours sits above that observation and far below the ten hour
 * silence nobody saw.
 */
export const IDLE_GATE_BOUND_MILLISECONDS = 4 * 60 * 60_000

export type CiGateReading
  /** Not a CI Review gate this service reports on. */
  = | { _tag: 'Ignored', reason: string }
    | { _tag: 'Within', elapsedMilliseconds: number, boundMilliseconds: number }
    | {
      _tag: 'Overdue'
      cause: CiGateCause
      /** When the gate last moved. */
      pendingSince: string
      elapsedMilliseconds: number
      boundMilliseconds: number
    }

export interface CiGateReadingInput {
  gates: ReviewGates
  cause: CiGateCause
  /** When the Review gates last changed. */
  pendingSince: string
  now: Date
}

function boundMilliseconds(cause: CiGateCause): number {
  return cause._tag === 'CheckRunning' || cause._tag === 'CheckQueued' ? RUNNING_CHECK_BOUND_MILLISECONDS : IDLE_GATE_BOUND_MILLISECONDS
}

/**
 * Reads one CI Review gate as healthy, young, or overdue.
 *
 * Three states are deliberately excluded. A gate that passed says the
 * repository has no CI or that CI answered, and the review contract calls both
 * settled. A pull request whose merge or review gate is unsettled already
 * waits for a person, so its CI Review gate is not what holds it. A lost
 * runner raises `runner_lost`, and one fault must never fill the pane twice.
 */
export function readCiGate(input: CiGateReadingInput): CiGateReading {
  if (input.gates.ci._tag !== 'Pending')
    return { _tag: 'Ignored', reason: 'The CI Review gate is not PENDING.' }
  if (input.gates.merge._tag !== 'Passed' || input.gates.review._tag !== 'Passed')
    return { _tag: 'Ignored', reason: 'Another Review gate holds this pull request.' }
  if (input.cause._tag === 'Settled' || input.cause._tag === 'RunnerLost')
    return { _tag: 'Ignored', reason: 'This CI Review gate has its own Incident.' }
  const since = Date.parse(input.pendingSince)
  if (Number.isNaN(since))
    return { _tag: 'Ignored', reason: 'The controller has no record of when the gate moved.' }
  const bound = boundMilliseconds(input.cause)
  const elapsedMilliseconds = input.now.getTime() - since
  if (elapsedMilliseconds <= bound)
    return { _tag: 'Within', elapsedMilliseconds, boundMilliseconds: bound }
  return { _tag: 'Overdue', cause: input.cause, pendingSince: input.pendingSince, elapsedMilliseconds, boundMilliseconds: bound }
}

function causeSentence(cause: CiGateCause): string {
  switch (cause._tag) {
    case 'BaseBranchFailed':
      return `Base branch check run "${cause.check}" failed.`
    case 'NoCheckRun':
      return cause.detail
    case 'CheckRunning':
      return `Check run "${cause.check}" has not reported a conclusion.`
    case 'CheckQueued':
      return `Check run "${cause.check}" is queued, and no runner has accepted the job.`
    case 'ChecksUnreadable':
      return `The controller cannot read the check runs. GitHub said: ${cause.reason}`
    default:
      return 'The controller cannot name what holds the gate.'
  }
}

function actionSentence(cause: CiGateCause): string {
  switch (cause._tag) {
    case 'BaseBranchFailed':
      return 'If the default branch is broken, repair it and re-run the check run.'
    case 'NoCheckRun':
      return 'If CI never started, read the workflow triggers and the runner.'
    case 'CheckRunning':
      return 'GitHub stops a job after six hours, so re-run the check run.'
    case 'CheckQueued':
      return 'If the job stays queued, read the runner supervisor on Hogwild.'
    case 'ChecksUnreadable':
      return 'If the read keeps failing, read the GitHub App installation permissions.'
    default:
      return 'Read the pull request checks on GitHub.'
  }
}

/**
 * Writes the one message this gate raises, however long it goes on.
 *
 * An Incident is identified by its message, so a message carrying the elapsed
 * time would mint a new Incident on every pass and lose the first seen time
 * that makes a long silence obvious. The bound and the moment the gate last
 * moved say the same thing and never change, so one gate keeps one Incident
 * and the pane counts its occurrences.
 */
export function ciGatePendingMessage(
  repository: string,
  pullRequestNumber: number,
  reading: Extract<CiGateReading, { _tag: 'Overdue' }>,
): string {
  const hours = Math.round(reading.boundMilliseconds / 3_600_000)
  return [
    `${repository}#${pullRequestNumber}: the CI Review gate reads PENDING for more than ${hours} hours.`,
    `The gate last moved at ${updatedAtLabel(reading.pendingSince)}.`,
    causeSentence(reading.cause),
    actionSentence(reading.cause),
  ].join(' ')
}
