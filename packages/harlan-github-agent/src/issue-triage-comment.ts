import { automatedDisclosure } from './review-comment.ts'

export const AUTOMATED_ISSUE_TRIAGE_MARKER = '<!-- harlan-agent-kit:issue-triage -->'

export interface IssueTriageCommentInput {
  validity: 'valid' | 'invalid' | 'needs_information'
  difficulty: number
  impact: number
  hasReproduction: boolean
  needsCodebaseReview: boolean
  summary: string
  nextAction: string
}

function validityLabel(validity: IssueTriageCommentInput['validity']): string {
  if (validity === 'valid')
    return 'Valid'
  if (validity === 'invalid')
    return 'Invalid'
  return 'Needs information'
}

export function issueTriageComment(input: IssueTriageCommentInput): string {
  return `${AUTOMATED_ISSUE_TRIAGE_MARKER}
### 🤖 ISSUE TRIAGE

${automatedDisclosure({ kind: 'triage', disclaimer: `It is not Harlan's personal assessment or commitment.` })}

- **Validity:** ${validityLabel(input.validity)}
- **Difficulty:** ${input.difficulty}/5
- **Impact:** ${input.impact}/5
- **Reproduction:** ${input.hasReproduction ? 'Yes' : 'No'}
- **Codebase review:** ${input.needsCodebaseReview ? 'Needed' : 'Not needed'}
- **Summary:** ${input.summary}
- **Next action:** ${input.nextAction}`
}
