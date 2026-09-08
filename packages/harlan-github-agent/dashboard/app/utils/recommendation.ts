import type { DashboardSnapshot, QueueEntry, ReviewAgent } from '../../../src/types.ts'
import { parseStoredIssueTriage } from '../../../src/issue-triage.ts'
import { approvalActionLabel, approvalConsequence, taskNumber } from './dashboard.ts'

export type QueueRecommendation
  = | { _tag: 'Approve', label: string, description: string }
    | { _tag: 'Dismiss', label: 'Dismiss', description: string }
    | { _tag: 'OpenGitHub', label: string, description: string, url: string }
    | { _tag: 'Inspect', label: string, description: string, instructions: string }

/** Recommendations explain existing authority. Only AwaitingApproval can grant it. */
export function queueRecommendation(entry: QueueEntry, snapshot: DashboardSnapshot): QueueRecommendation | undefined {
  const approval = approvalActionLabel(entry)
  if (approval !== undefined)
    return { _tag: 'Approve', label: approval, description: approvalConsequence(entry) }
  if (entry.state._tag !== 'ActionRequired')
    return undefined

  const details: QueueRecommendation = {
    _tag: 'Inspect',
    label: 'View details',
    description: 'Read the next step and copy the task to your agent.',
    instructions: entry.state.reason,
  }
  const tasks = snapshot.tasks.filter(task => task.repository === entry.repository
    && taskNumber(task) === entry.number && task.revisionId === entry.revisionId)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  if (entry.kind === 'issue') {
    // A stopped implementation outranks the triage that originally started it.
    const stopped = tasks.find(task => task.kind === 'issue_work'
      && (task.state._tag === 'ActionRequired' || task.state._tag === 'Failed'))
    if (stopped !== undefined && (stopped.state._tag === 'ActionRequired' || stopped.state._tag === 'Failed')) {
      return {
        _tag: 'Inspect',
        label: 'View failure',
        description: 'Read why Issue work stopped before starting another task.',
        instructions: stopped.state.reason,
      }
    }
    const task = tasks.find(task => task.kind === 'issue_triage')
    const triage = parseStoredIssueTriage(task?.state._tag === 'Completed' ? task.state.evidence : null)
    if (triage?._tag === 'READY_TO_SPEC') {
      return {
        _tag: 'Inspect',
        label: 'Write spec',
        description: 'Copy the task to your agent. Add the agreed spec to the issue before implementation.',
        instructions: triage.nextAction,
      }
    }
    if (triage?._tag === 'NEEDS_INFO') {
      return {
        _tag: 'Inspect',
        label: 'Provide info',
        description: 'Read the requested evidence. Add it to the issue so triage can continue.',
        instructions: triage.nextAction,
      }
    }
    return details
  }

  const item = snapshot.items.find(item => item.kind === 'pull_request'
    && item.repository === entry.repository && item.number === entry.number && item.revisionId === entry.revisionId)
  if (item?.kind === 'pull_request' && item.mergeState === 'conflicting') {
    return {
      _tag: 'OpenGitHub',
      label: 'Resolve conflicts',
      description: 'Open GitHub to resolve the merge conflicts or check branch access.',
      url: entry.subjectUrl,
    }
  }

  // Several reviews can share a head. A repaired finding must never recommend Dismiss again.
  const review = snapshot.agents.filter((agent): agent is ReviewAgent => agent._tag === 'ReviewAgent'
    && agent.repository === entry.repository && agent.pullRequestNumber === entry.number
    && agent.revisionId === entry.revisionId && agent.headSha === entry.headSha)
    .toSorted((a, b) => b.completedAt.localeCompare(a.completedAt))[0]
  const findings = review?.findings.filter(finding => finding._tag === 'Open') ?? []
  const dismissal = findings.find(finding => finding.resolution === 'Dismissal')
  if (dismissal !== undefined)
    return { _tag: 'Dismiss', label: 'Dismiss', description: dismissal.nextAction }
  if (findings.length > 0) {
    return {
      _tag: 'Inspect',
      label: 'Review issues',
      description: 'Read the proposed fixes and copy the repair task to your agent.',
      instructions: findings.map(finding => `${finding.summary}\n${finding.nextAction}`).join('\n\n'),
    }
  }
  if (review?.gates.ci._tag === 'Failed' || review?.gates.ci._tag === 'Pending') {
    return {
      _tag: 'OpenGitHub',
      label: 'View checks',
      description: review.gates.ci.reason,
      url: `${entry.subjectUrl}/checks`,
    }
  }
  return details
}

/** A copied task carries its source and scope, even after the dashboard changes. */
export function recommendationTask(entry: QueueEntry, recommendation: Extract<QueueRecommendation, { _tag: 'Inspect' }>): string {
  const scope = recommendation.label === 'Write spec'
    ? 'Draft a spec for review. Do not implement or publish it yet.'
    : 'Check the current GitHub state. Investigate the next step below and report what remains.'
  return `${recommendation.label}: ${entry.title}\n${entry.subjectUrl}\n\n${scope}\n\n${recommendation.instructions}`
}
