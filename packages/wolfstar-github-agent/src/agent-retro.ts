import type { JournalStore } from './store.ts'
import { redactSecrets } from './agent-activity.ts'

const sourceLimit = 1000
const eventLimit = 200
const incidentLimit = 50
const weekMilliseconds = 7 * 24 * 60 * 60 * 1000

/** Durable controller evidence. Never export credentials, prompts, or raw transcripts. */
export function collectAgentRetroEvidence(
  store: Pick<JournalStore, 'listIncidents' | 'listWorkflowEvents'>,
  now: Date,
) {
  const since = new Date(now.getTime() - weekMilliseconds).toISOString()
  const source = store.listWorkflowEvents({ limit: sourceLimit })
  const recent = source.filter((event) => Date.parse(event.occurredAt) >= Date.parse(since))
  // Keep failed and repeated work first, then representative successful work.
  const ranked = [...recent].sort((left, right) => {
    const priority = (event: typeof left) => Number(event.reason !== null) + Number(event.attempt > 1)
    return priority(right) - priority(left) || Date.parse(right.occurredAt) - Date.parse(left.occurredAt)
  })
  const incidents = store.listIncidents()
  return {
    observedAt: now.toISOString(),
    since,
    coverage: {
      events:
        recent.length > eventLimit || (source.length === sourceLimit && recent.length === sourceLimit)
          ? ('incomplete' as const)
          : ('complete' as const),
      sourceLimit,
      sampledEvents: Math.min(eventLimit, recent.length),
      omittedEvents: Math.max(0, recent.length - eventLimit),
      oldestSourceEventAt: source.at(-1)?.occurredAt ?? null,
      incidents: incidents.length > incidentLimit ? ('incomplete' as const) : ('complete' as const),
      omittedIncidents: Math.max(0, incidents.length - incidentLimit),
      transcripts: 'unavailable' as const,
      resolvedIncidents: 'unavailable' as const,
      systemLogs: 'unavailable' as const,
    },
    incidents: incidents.slice(0, incidentLimit).map((incident) => ({
      ...incident,
      message: redactSecrets(incident.message).slice(0, 1600),
    })),
    events: ranked.slice(0, eventLimit).map((event) => ({
      ...event,
      reason: event.reason === null ? null : redactSecrets(event.reason).slice(0, 1600),
    })),
  }
}
