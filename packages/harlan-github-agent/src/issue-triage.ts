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
