import type { JournalStore } from './store.ts'
import { redactSecrets } from './agent-activity.ts'

const failureLimit = 1000
const eventLimit = 200
const incidentLimit = 50
const weekMilliseconds = 7 * 24 * 60 * 60 * 1000

/** Durable controller evidence. Never export credentials, prompts, or raw transcripts. */
export function collectAgentRetroEvidence(
  store: Pick<JournalStore, 'listIncidents' | 'listWorkflowEvents' | 'summarizeWorkflowEvents'>,
  now: Date,
) {
  const since = new Date(now.getTime() - weekMilliseconds).toISOString()
  // A busy week holds more than a thousand events, so failures are read across the whole
  // window first. A newest-first page would only reach back a few hours.
  const failures = store.listWorkflowEvents({ since, failures: true, limit: failureLimit })
  const recent = store.listWorkflowEvents({ since, limit: eventLimit })
  const failureIds = new Set(failures.map(event => event.id))
  const events = [...failures, ...recent.filter(event => !failureIds.has(event.id))].slice(0, eventLimit + failureLimit)
  const summary = store.summarizeWorkflowEvents({ since })
  const total = summary.reduce((sum, row) => sum + row.count, 0)
  const incidents = store.listIncidents()
  return {
    observedAt: now.toISOString(),
    since,
    coverage: {
      events: failures.length === failureLimit ? 'incomplete' as const : 'complete' as const,
      windowEvents: total,
      failureEvents: failures.length,
      sampledEvents: events.length,
      omittedEvents: Math.max(0, total - events.length),
      incidents: incidents.length > incidentLimit ? 'incomplete' as const : 'complete' as const,
      omittedIncidents: Math.max(0, incidents.length - incidentLimit),
      transcripts: 'unavailable' as const,
      resolvedIncidents: 'unavailable' as const,
      systemLogs: 'unavailable' as const,
    },
    summary,
    incidents: incidents.slice(0, incidentLimit).map(incident => ({
      ...incident,
      message: redactSecrets(incident.message).slice(0, 1600),
    })),
    events: events.map(event => ({
      ...event,
      reason: event.reason === null ? null : redactSecrets(event.reason).slice(0, 1600),
    })),
  }
}
