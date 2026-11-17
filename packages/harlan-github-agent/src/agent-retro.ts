import type { JournalStore } from './store.ts'
import { redactSecrets } from './agent-activity.ts'

const failureGroupLimit = 60
const failureSampleLimit = 40
const sampleReasonLength = 400
const incidentLimit = 50
const weekMilliseconds = 7 * 24 * 60 * 60 * 1000

/** Durable controller evidence. Never export credentials, prompts, or raw transcripts. */
export function collectAgentRetroEvidence(
  store: Pick<JournalStore, 'groupWorkflowFailures' | 'listIncidents' | 'listWorkflowEvents' | 'summarizeWorkflowEvents'>,
  now: Date,
) {
  const since = new Date(now.getTime() - weekMilliseconds).toISOString()
  // A busy week holds over a thousand failures; groups count all of them within one prompt.
  const groups = store.groupWorkflowFailures({ since })
  const sample = store.listWorkflowEvents({ since, failures: true, limit: failureSampleLimit })
  const summary = store.summarizeWorkflowEvents({ since })
  const incidents = store.listIncidents()
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
    failureGroups: groups.slice(0, failureGroupLimit).map(group => ({
      ...group,
      reason: group.reason === null ? null : redactSecrets(group.reason),
    })),
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
