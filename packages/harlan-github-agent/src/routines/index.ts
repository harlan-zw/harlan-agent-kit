import { agentFeedback } from './agent-feedback.ts'
import { ciReview } from './ci-review.ts'
import { dailyCheckin } from './daily-checkin.ts'
import { dependencyUpdates } from './dependency-updates.ts'
import { prTriage } from './pr-triage.ts'
import { sentryCheckin } from './sentry-checkin.ts'

// Only compiled definitions grant Routine authority. YAML selects a name from this table.
const routines = {
  'sentry-checkin': sentryCheckin,
  'pr-triage': prTriage,
  'agent-feedback': agentFeedback,
  'daily-checkin': dailyCheckin,
  'dependency-updates': dependencyUpdates,
  'ci-review': ciReview,
}

export type RoutineName = keyof typeof routines
export const ROUTINE_NAMES: readonly RoutineName[] = Object.keys(routines) as RoutineName[]

export function getRoutine(name: RoutineName) {
  return routines[name]
}
