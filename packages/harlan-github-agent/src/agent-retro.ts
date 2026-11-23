import type { RoutineYieldRun } from './routine-yield-store.ts'
import type { JournalStore } from './store.ts'
import { redactSecrets } from './agent-activity.ts'

const failureGroupLimit = 150
const detailedGroupLimit = 20
const failureSampleLimit = 40
const sampleReasonLength = 400
const incidentLimit = 50
const weekMilliseconds = 7 * 24 * 60 * 60 * 1000
// Rows with a legend: 150 keyed groups alone would fill the prompt budget.
const groupColumns = ['stream', 'event', 'to', 'reason', 'count', 'retried', 'examples'] as const
const exampleColumns = ['id', 'entityId', 'repository', 'itemNumber', 'occurredAt'] as const
const yieldColumns = ['routine', 'mode', 'repositories', 'runs', 'completed', 'green', 'amber', 'red', 'noVerdict', 'coverageIncomplete', 'candidates', 'issuesRequested', 'controllerRequests', 'stalled', 'requests'] as const
/** A proposing Routine with this many non-GREEN runs and no Candidate in the window is stalled. */
const stalledRunThreshold = 5
const requestSampleLimit = 3
const requestLength = 200
/**
 * How reports name the Controller as next actor. Each capture starts where the request starts.
 * Worker reports from November 2026 used all three forms.
 */
const controllerRequestForms = [
  // `1. Controller: supply issue bodies.` or `- **Controller owner:** confirm the Worker version.`
  /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\*\*|__)?(Controller(?:\s+[a-z]+)?(?:\*\*|__)?\s*:.*)$/,
  // `Coverage incomplete. Next action: controller supplies issue bodies.`
  /\b(next(?:\s+(?:action|actor|step))?(?:\*\*|__)?\s*:\s*(?:the\s+)?controller\b.*)$/i,
  // `Scheduler owner: diagnose starvation. Controller must supply ownership records.`
  /\b(Controller\s+must\b.*)$/,
] as const

function controllerRequests(report: string | null): string[] {
  return (report ?? '').split('\n').flatMap((line) => {
    const request = controllerRequestForms.map(form => form.exec(line)?.[1]).find(match => match !== undefined)
    return request === undefined ? [] : [redactSecrets(request.replaceAll('**', '').trim()).slice(0, requestLength)]
  })
}

/**
 * Counts what each Routine yielded, one row per name and mode, stalled Routines first.
 *
 * A Routine run that completes with no Candidate is no Workflow failure, so
 * the failure groups never show a Routine that stopped proposing. From
 * September to November 2026 every daily check-in completed AMBER with no
 * Candidate, and asked the Controller for issue bodies in report prose nobody
 * read. This row makes that pattern a failure the retro can see.
 */
function routineYieldRows(runs: readonly RoutineYieldRun[]) {
  return [...Map.groupBy(runs, run => `${run.name} ${run.mode}`).values()]
    .flatMap((group) => {
      const [first] = group
      if (first === undefined)
        return []
      const count = (matches: (run: RoutineYieldRun) => boolean) => group.filter(matches).length
      const green = count(run => run.verdict?.severity === 'GREEN')
      const amber = count(run => run.verdict?.severity === 'AMBER')
      const red = count(run => run.verdict?.severity === 'RED')
      const candidates = group.reduce((sum, run) => sum + run.candidates, 0)
      const requests = group.map(run => controllerRequests(run.report))
      return [{
        name: first.name,
        mode: first.mode,
        stalled: first.mode === 'propose' && amber + red >= stalledRunThreshold && candidates === 0,
        row: [
          first.name,
          first.mode,
          new Set(group.map(run => run.repository)).size,
          group.length,
          count(run => run.state === 'Completed'),
          green,
          amber,
          red,
          count(run => run.verdict === null),
          count(run => run.verdict?.coverage === 'incomplete'),
          candidates,
          group.reduce((sum, run) => sum + run.issuesRequested, 0),
          requests.filter(lines => lines.length > 0).length,
        ] as const,
        requests: [...new Set(requests.flat())].slice(0, requestSampleLimit),
      }]
    })
    .sort((left, right) => Number(right.stalled) - Number(left.stalled) || left.name.localeCompare(right.name) || left.mode.localeCompare(right.mode))
    .map(entry => [...entry.row, entry.stalled, entry.requests] as const)
}

/** Durable controller evidence. Never export credentials, prompts, or raw transcripts. */
export function collectAgentRetroEvidence(
  store: Pick<JournalStore, 'groupWorkflowFailures' | 'listIncidents' | 'listRoutineYieldRuns' | 'listWorkflowEvents' | 'summarizeWorkflowEvents'>,
  now: Date,
) {
  const since = new Date(now.getTime() - weekMilliseconds).toISOString()
  // A busy week holds over a thousand failures; groups count all of them within one prompt.
  const groups = store.groupWorkflowFailures({ since })
  const sample = store.listWorkflowEvents({ since, failures: true, limit: failureSampleLimit })
  const summary = store.summarizeWorkflowEvents({ since })
  const incidents = store.listIncidents()
  const routineYield = routineYieldRows(store.listRoutineYieldRuns({ since }))
  return {
    observedAt: now.toISOString(),
    since,
    coverage: {
      events: groups.length > failureGroupLimit ? 'incomplete' as const : 'complete' as const,
      windowEvents: summary.reduce((sum, row) => sum + row.count, 0),
      failureEvents: groups.reduce((sum, group) => sum + group.count, 0),
      failureGroups: groups.length,
      omittedFailureGroups: Math.max(0, groups.length - failureGroupLimit),
      sampledFailureEvents: sample.length,
      incidents: incidents.length > incidentLimit ? 'incomplete' as const : 'complete' as const,
      omittedIncidents: Math.max(0, incidents.length - incidentLimit),
      transcripts: 'unavailable' as const,
      resolvedIncidents: 'unavailable' as const,
      systemLogs: 'unavailable' as const,
    },
    summary,
    failureGroups: {
      columns: groupColumns,
      exampleColumns,
      rows: groups.slice(0, failureGroupLimit).map((group, index) => [
        group.stream,
        group.event,
        group.to,
        group.reason === null ? null : redactSecrets(group.reason),
        group.count,
        group.retried,
        (index < detailedGroupLimit ? group.examples : group.examples.slice(0, 1))
          .map(example => [example.id, example.entityId, example.repository, example.itemNumber, example.occurredAt] as const),
      ] as const),
    },
    routineYield: {
      columns: yieldColumns,
      rows: routineYield,
    },
    failureSample: sample.map(event => ({
      ...event,
      reason: event.reason === null ? null : redactSecrets(event.reason).slice(0, sampleReasonLength),
    })),
    incidents: incidents.slice(0, incidentLimit).map(incident => ({
      ...incident,
      message: redactSecrets(incident.message).slice(0, 1600),
    })),
  }
}
