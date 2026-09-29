export const ISSUE_TRIAGE_STATES = [
  'READY_TO_IMPLEMENT',
  'READY_TO_SPEC',
  'NEEDS_INFO',
  'WAIT_TO_IMPLEMENT',
] as const

export type IssueTriageState = typeof ISSUE_TRIAGE_STATES[number]

export interface IssueTriageReference {
  number: number
  reason: string
}

interface IssueTriageEvidence {
  difficulty: number
  hasReproduction: boolean
  impact: number
  needsCodebaseReview: boolean
  nextAction: string
  summary: string
  /** Open issues in the same repository that the same change should fix. Empty when none. */
  relatedIssues: readonly number[]
  /** An open issue with the same cause and required fix. */
  duplicateIssue: IssueTriageReference | null
  /** Pull requests that explain current or past work on this issue. */
  relatedPullRequests: readonly IssueTriageReference[]
}

/** One routing decision, with the evidence the next Agent receives. */
export type IssueTriageResult = {
  [State in IssueTriageState]: IssueTriageEvidence & { _tag: State }
}[IssueTriageState]

export function isIssueTriageState(value: unknown): value is IssueTriageState {
  return typeof value === 'string' && ISSUE_TRIAGE_STATES.includes(value as IssueTriageState)
}

export function issueTriageStateLabel(state: IssueTriageState): string {
  switch (state) {
    case 'READY_TO_IMPLEMENT': return 'Ready to implement'
    case 'READY_TO_SPEC': return 'Ready to spec'
    case 'NEEDS_INFO': return 'Needs info'
    case 'WAIT_TO_IMPLEMENT': return 'Wait to implement'
  }
}

function issueReference(value: unknown): IssueTriageReference | null {
  if (typeof value !== 'object' || value === null)
    return null
  const record = value as Record<string, unknown>
  if (!Number.isInteger(record.number) || (record.number as number) < 1 || typeof record.reason !== 'string' || record.reason.trim() === '')
    return null
  return { number: record.number as number, reason: record.reason.trim().replace(/\s+/gu, ' ') }
}

/**
 * Reads one stored Issue triage result back from Task evidence.
 *
 * The controller stores the Agent's JSON as the evidence of the completed
 * Issue triage Task. Issue work reads it so the Agent does not triage twice.
 */
export function parseStoredIssueTriage(evidence: string | null | undefined): IssueTriageResult | null {
  if (evidence === null || evidence === undefined)
    return null
  let value: unknown
  try {
    value = JSON.parse(evidence)
  }
  catch {
    return null
  }
  if (typeof value !== 'object' || value === null)
    return null
  const record = value as Record<string, unknown>
  if (
    !isIssueTriageState(record._tag)
    || typeof record.summary !== 'string'
    || typeof record.nextAction !== 'string'
    || typeof record.difficulty !== 'number'
    || typeof record.impact !== 'number'
    || typeof record.hasReproduction !== 'boolean'
    || typeof record.needsCodebaseReview !== 'boolean'
  ) {
    return null
  }
  // Evidence stored before triage named related issues carries no list.
  const relatedIssues = Array.isArray(record.relatedIssues)
    ? record.relatedIssues.filter((value): value is number => Number.isInteger(value) && (value as number) > 0)
    : []
  const duplicateIssue = record.duplicateIssue === undefined || record.duplicateIssue === null
    ? null
    : issueReference(record.duplicateIssue)
  if (record.duplicateIssue != null && duplicateIssue === null)
    return null
  if (duplicateIssue !== null && record._tag !== 'WAIT_TO_IMPLEMENT')
    return null
  const rawPullRequests = record.relatedPullRequests === undefined ? [] : record.relatedPullRequests
  if (!Array.isArray(rawPullRequests) || rawPullRequests.length > 3)
    return null
  const relatedPullRequests: IssueTriageReference[] = []
  for (const value of rawPullRequests) {
    const reference = issueReference(value)
    if (reference === null)
      return null
    relatedPullRequests.push(reference)
  }
  return {
    _tag: record._tag,
    difficulty: record.difficulty,
    impact: record.impact,
    hasReproduction: record.hasReproduction,
    needsCodebaseReview: record.needsCodebaseReview,
    summary: record.summary,
    nextAction: record.nextAction,
    relatedIssues,
    duplicateIssue,
    relatedPullRequests,
  }
}
