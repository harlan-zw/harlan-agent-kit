import type { DashboardSnapshot, QueueEntry } from '../../../src/types.ts'
import type { QueueAttention } from './attention.ts'
import { queueAttention } from './attention.ts'
import { approvalActionLabel, approvalConsequence } from './dashboard.ts'

type RecommendationContext = Pick<QueueAttention, 'owner' | 'blocker' | 'summary'>

export type QueueRecommendation = RecommendationContext & (
  | { _tag: 'Approve', label: string, description: string }
  | { _tag: 'Dismiss', label: 'Dismiss', description: string }
  | { _tag: 'OpenGitHub', label: string, description: string, url: string }
  | { _tag: 'Inspect', label: string, description: string, instructions: string }
)

/** Button labels describe what the click does. Opening instructions never starts an agent. */
export function queueRecommendation(entry: QueueEntry, snapshot: DashboardSnapshot): QueueRecommendation | undefined {
  const attention = queueAttention(entry, snapshot)
  if (attention === undefined)
    return undefined
  const context: RecommendationContext = { owner: attention.owner, blocker: attention.blocker, summary: attention.summary }
  switch (attention._tag) {
    case 'Approval':
      return { ...context, _tag: 'Approve', label: approvalActionLabel(entry)!, description: approvalConsequence(entry) }
    case 'Dismissal':
      return { ...context, _tag: 'Dismiss', label: 'Dismiss', description: attention.instructions }
    case 'Checks':
      return { ...context, _tag: 'OpenGitHub', label: 'View checks', description: attention.summary, url: `${entry.subjectUrl}/checks` }
    case 'Permissions': {
      const item = snapshot.items.find(item => item.kind === 'pull_request'
        && item.repository === entry.repository && item.number === entry.number && item.revisionId === entry.revisionId)
      if (item?.kind === 'pull_request' && item.approval._tag === 'ReviewRequired') {
        return {
          ...context,
          _tag: 'OpenGitHub',
          label: 'Approve on GitHub',
          description: 'Add harlan-agent-review on GitHub to authorize review and repair for this head.',
          url: entry.subjectUrl,
        }
      }
      return {
        ...context,
        _tag: 'Inspect',
        label: 'View access steps',
        description: 'Check repository conflict settings and branch permissions. This button does not change them.',
        instructions: attention.instructions,
      }
    }
    default: {
      const labels = {
        Spec: 'Open spec task',
        Evidence: 'Open investigation',
        Repair: 'Open repair task',
        Recovery: 'Open recovery task',
        Decision: 'View decision',
        Information: 'View request',
        Unknown: 'View blocker',
      } as const
      return {
        ...context,
        _tag: 'Inspect',
        label: labels[attention._tag],
        description: attention.owner === 'Agent'
          ? 'Open the instructions and copy them to an agent. This task is not queued.'
          : 'Read the required action below. Opening this panel does not approve or start work.',
        instructions: attention.instructions,
      }
    }
  }
}

/** A copied task carries its source and scope, even after the dashboard changes. */
export function recommendationTask(entry: QueueEntry, recommendation: Extract<QueueRecommendation, { _tag: 'Inspect' }>): string {
  const scope = recommendation.blocker === 'Spec needed'
    ? 'Draft a spec for review. Do not implement or publish it yet.'
    : 'Check the current GitHub state. Investigate the next step below and report what remains.'
  return `${recommendation.blocker}: ${entry.title}\n${entry.subjectUrl}\n\n${scope}\n\n${recommendation.instructions}`
}
