import type { DashboardSnapshot, QueueEntry, ReviewAgent } from '../../../src/types.ts'
import { parseStoredIssueTriage } from '../../../src/issue-triage.ts'

interface AttentionDetails { blocker: string, summary: string, instructions: string }

export type QueueAttention = AttentionDetails & (
  | { owner: 'You', _tag: 'Approval' | 'Decision' | 'Information' | 'Permissions' | 'Dismissal' | 'Unknown' }
  | { owner: 'Agent', _tag: 'Spec' | 'Evidence' | 'Repair' | 'Checks' | 'Recovery' }
)

/** Stored triage records name the next actor in prose. Unknown requests stay with the human. */
function requestsHumanAction(text: string): boolean {
  return /\b(?:harlan|operator|owner|user)\s+(?:picks?|chooses?|decides?|approves?|confirms?|must|needs? to)\b|\b(?:ask|request)\s+(?:the\s+)?(?:operator|owner|user|harlan)\b|\b(?:you|operator|owner)\s+(?:to\s+)?(?:provide|perform|connect|approve|confirm)\b|\b(?:permission denied|approval required|credentials? required)\b/i.test(text)
}

function requestsEvidenceRead(text: string): boolean {
  const action = text.trim().replace(/^in [^\n,:]+[,:]/i, '').trimStart()
  return /^(?:run|read|query|check|compare|inspect|fetch|pull|verify|list|enumerate)\b/i.test(action)
}

/** Classifies the next action, without changing scheduling or granting authority. */
export function queueAttention(entry: QueueEntry, snapshot: DashboardSnapshot): QueueAttention | undefined {
  if (entry.state._tag === 'AwaitingApproval') {
    return {
      owner: 'You',
      _tag: 'Approval',
      blocker: 'Approval required',
      summary: 'Your approval lets an agent start.',
      instructions: '',
    }
  }
  if (entry.state._tag !== 'ActionRequired')
    return undefined

  const unknown: QueueAttention = {
    owner: 'You',
    _tag: 'Unknown',
    blocker: 'Owner unclear',
    summary: 'Review the blocker to decide who acts next.',
    instructions: entry.state.reason,
  }
  if (entry.kind === 'issue') {
    const tasks = snapshot.tasks.filter(task => task.repository === entry.repository
      && ('issueNumber' in task ? task.issueNumber : task.pullRequestNumber) === entry.number
      && task.revisionId === entry.revisionId)
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const stopped = tasks.find(task => task.kind === 'issue_work'
      && (task.state._tag === 'ActionRequired' || task.state._tag === 'Failed'))
    if (stopped?.state._tag === 'ActionRequired' || stopped?.state._tag === 'Failed') {
      const instructions = stopped.state.reason
      return requestsHumanAction(instructions)
        ? { owner: 'You', _tag: 'Information', blocker: 'Your action needed', summary: 'The agent needs your help to continue.', instructions }
        : { owner: 'Agent', _tag: 'Recovery', blocker: 'Agent stopped', summary: 'An agent needs to investigate why the previous task stopped.', instructions }
    }
    const task = tasks.find(task => task.kind === 'issue_triage')
    const triage = parseStoredIssueTriage(task?.state._tag === 'Completed' ? task.state.evidence : null)
    if (triage?._tag === 'READY_TO_SPEC') {
      const instructions = triage.nextAction
      return requestsHumanAction(instructions)
        ? { owner: 'You', _tag: 'Decision', blocker: 'Decision needed', summary: 'Your decision is needed before an agent writes the spec.', instructions }
        : { owner: 'Agent', _tag: 'Spec', blocker: 'Spec needed', summary: 'An agent can gather evidence and draft a recommendation.', instructions }
    }
    if (triage?._tag === 'NEEDS_INFO') {
      const instructions = triage.nextAction
      return !requestsHumanAction(instructions) && requestsEvidenceRead(instructions)
        ? { owner: 'Agent', _tag: 'Evidence', blocker: 'Evidence needed', summary: 'An agent can read the logs or data before asking you.', instructions }
        : { owner: 'You', _tag: 'Information', blocker: 'Information needed', summary: 'Your information or account access is needed to continue.', instructions }
    }
    return unknown
  }

  const item = snapshot.items.find(item => item.kind === 'pull_request'
    && item.repository === entry.repository && item.number === entry.number && item.revisionId === entry.revisionId)
  if (item?.kind === 'pull_request' && item.mergeState === 'conflicting') {
    return {
      owner: 'You',
      _tag: 'Permissions',
      blocker: item.approval._tag === 'ReviewRequired' ? 'Approval required' : 'Access needed',
      summary: item.approval._tag === 'ReviewRequired'
        ? 'Approve work on this contributor commit before conflict resolution.'
        : 'Allow conflict resolution or resolve the conflicts yourself.',
      instructions: item.approval._tag === 'ReviewRequired'
        ? entry.state.reason
        : /conflict resolution is off/i.test(entry.state.reason)
          ? `${entry.state.reason}\n\nEnable conflict_resolution for ${entry.repository} in the service configuration, or resolve the conflicts on GitHub.`
          : `${entry.state.reason}\n\nCheck write permission for ${item.headRepository}:${item.headRef}. Keep any permission change limited to this repository and branch.`,
    }
  }

  const review = snapshot.agents.filter((agent): agent is ReviewAgent => agent._tag === 'ReviewAgent'
    && agent.repository === entry.repository && agent.pullRequestNumber === entry.number
    && agent.revisionId === entry.revisionId && agent.headSha === entry.headSha)
    .toSorted((a, b) => b.completedAt.localeCompare(a.completedAt))[0]
  const findings = review?.findings.filter(finding => finding._tag === 'Open') ?? []
  const dismissal = findings.find(finding => finding.resolution === 'Dismissal')
  if (dismissal !== undefined) {
    return {
      owner: 'You',
      _tag: 'Dismissal',
      blocker: 'Decision needed',
      summary: dismissal.summary,
      instructions: dismissal.nextAction,
    }
  }
  if (findings.length > 0) {
    return {
      owner: 'Agent',
      _tag: 'Repair',
      blocker: 'Repair needed',
      summary: findings.length === 1 ? findings[0]!.summary : `${findings.length} review issues need repair.`,
      instructions: findings.map(finding => `${finding.summary}\n${finding.nextAction}`).join('\n\n'),
    }
  }
  if (review?.gates.ci._tag === 'Failed' || review?.gates.ci._tag === 'Pending') {
    return {
      owner: 'Agent',
      _tag: 'Checks',
      blocker: review.gates.ci._tag === 'Failed' ? 'Checks failed' : 'Checks pending',
      summary: review.gates.ci.reason,
      instructions: 'Read the check logs. Compare the failure with the base branch before proposing a repair.',
    }
  }
  return unknown
}
