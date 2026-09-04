export const ISSUE_TRIAGE_STATES = [
  'READY_TO_IMPLEMENT',
  'READY_TO_SPEC',
  'NEEDS_INFO',
  'WAIT_TO_IMPLEMENT',
] as const

export type IssueTriageState = typeof ISSUE_TRIAGE_STATES[number]

interface IssueTriageEvidence {
  difficulty: number
  hasReproduction: boolean
  impact: number
  needsCodebaseReview: boolean
  nextAction: string
  summary: string
  /** Open issues in the same repository that the same change should fix. Empty when none. */
  relatedIssues: readonly number[]
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
  return {
    _tag: record._tag,
    difficulty: record.difficulty,
    impact: record.impact,
    hasReproduction: record.hasReproduction,
    needsCodebaseReview: record.needsCodebaseReview,
    summary: record.summary,
    nextAction: record.nextAction,
    relatedIssues,
  }
}
