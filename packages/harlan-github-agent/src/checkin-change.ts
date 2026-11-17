import type { RepositoryMapping, Routine, RoutineRun } from './types.ts'
import type { RoutineGitHubEvidence } from './worker-github-evidence.ts'
import { matchesCron, parseCron } from './routine-schedule.ts'

/**
 * Production deploys since a point in time, read from the required workflows.
 *
 * Take Ownership names the workflows that deliver a site, so a run of one on
 * the default branch is a deploy. GitHub Deployment records are not used: on
 * the gated sites they hold preview builds and npm releases, not site deploys.
 */
export type DeployEvidence
  = | { _tag: 'NotConfigured' }
    | { _tag: 'Unavailable', reason: string }
    | { _tag: 'Available', workflows: readonly string[], runs: ReadonlyArray<{ workflow: string, at: string }> }

export type CheckinChange
  = | { _tag: 'Changed', reason: string }
    | { _tag: 'Unchanged', evidence: string }

type WorkflowRuns = RoutineGitHubEvidence['workflowRuns']

function workflowMatches(entry: Record<string, string | number | null>, workflow: string): boolean {
  const path = typeof entry.path === 'string' ? entry.path.split('@')[0] : null
  return entry.name === workflow || path === workflow || path === `.github/workflows/${workflow}`
}

/** Reads required workflow runs on the default branch from the evidence the check-in already collects. */
export function readDeployEvidence(
  mapping: Pick<RepositoryMapping, 'defaultBranch' | 'takeOwnership'>,
  workflowRuns: WorkflowRuns,
): DeployEvidence {
  if (mapping.takeOwnership._tag === 'Disabled' || mapping.takeOwnership.requiredWorkflows.length === 0)
    return { _tag: 'NotConfigured' }
  const workflows = mapping.takeOwnership.requiredWorkflows
  if (workflowRuns._tag === 'Unavailable')
    return workflowRuns
  const runs = workflows.flatMap(workflow => workflowRuns.entries
    .filter(entry => entry.head_branch === mapping.defaultBranch && workflowMatches(entry, workflow))
    .flatMap((entry) => {
      const at = typeof entry.updated_at === 'string' ? entry.updated_at : entry.created_at
      return typeof at === 'string' ? [{ workflow, at }] : []
    }))
  // A truncated list may have dropped the very run that deployed.
  const missing = workflows.find(workflow => !runs.some(run => run.workflow === workflow))
  if (workflowRuns.truncated && missing !== undefined)
    return { _tag: 'Unavailable', reason: `The workflow run list is truncated, so it may omit ${missing}.` }
  return { _tag: 'Available', workflows, runs }
}

/**
 * Whether one run answers a cron instant of its Routine.
 *
 * A manual run answers the minute a person asked for it, so it runs whatever
 * changed.
 */
export function answersSchedule(routine: Pick<Routine, 'crons' | 'timeZone'>, scheduledFor: string): boolean {
  const at = new Date(scheduledFor)
  return routine.crons.some((cron) => {
    const expression = parseCron(cron)
    return expression._tag === 'Ok' && matchesCron(expression.value, at, routine.timeZone)
  })
}

/**
 * Decides whether a `when: changed` check-in spends an Agent turn.
 *
 * Every Routine run stores the default branch head SHA it checks out, so the
 * last Completed run is the baseline. Any doubt runs the check-in.
 */
export function checkinChange(input: {
  repository: string
  headSha: string
  baseline: Pick<RoutineRun, 'id' | 'specSha' | 'createdAt'> | null
  deploys: DeployEvidence
}): CheckinChange {
  const { baseline, deploys } = input
  if (baseline === null)
    return { _tag: 'Changed', reason: 'No Completed run exists to compare with.' }
  if (baseline.specSha !== input.headSha)
    return { _tag: 'Changed', reason: `The default branch moved from ${baseline.specSha.slice(0, 12)} to ${input.headSha.slice(0, 12)}.` }
  if (deploys._tag === 'Unavailable')
    return { _tag: 'Changed', reason: `Deploy evidence is unavailable: ${deploys.reason}` }
  const since = Date.parse(baseline.createdAt)
  const deployed = deploys._tag === 'Available' ? deploys.runs.find(run => Date.parse(run.at) > since) : undefined
  if (deployed !== undefined)
    return { _tag: 'Changed', reason: `${deployed.workflow} ran on the default branch at ${deployed.at}.` }
  return {
    _tag: 'Unchanged',
    evidence: [
      `daily-checkin on ${input.repository}`,
      `unchanged since run ${baseline.id}`,
      `head ${input.headSha.slice(0, 12)}`,
      deploys._tag === 'Available'
        ? `no ${deploys.workflows.join(' or ')} run since ${baseline.createdAt}`
        : 'no deploy workflow configured, so head SHA only',
      'no Agent turn',
      '0 issues requested',
    ].join(' | '),
  }
}
