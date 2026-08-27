import type { IssueTriageResult } from './issue-triage.ts'
import { issueTriageStateLabel } from './issue-triage.ts'
import { automatedDisclosure } from './review-comment.ts'

export const AUTOMATED_ISSUE_TRIAGE_MARKER = '<!-- harlan-agent-kit:issue-triage -->'

export function issueTriageComment(input: IssueTriageResult): string {
  return `${AUTOMATED_ISSUE_TRIAGE_MARKER}
### 🤖 ISSUE TRIAGE

${automatedDisclosure({ kind: 'triage', disclaimer: `It is not Harlan's personal assessment or commitment.` })}

- **Route:** ${issueTriageStateLabel(input._tag)}
- **Difficulty:** ${input.difficulty}/5
- **Impact:** ${input.impact}/5
- **Reproduction:** ${input.hasReproduction ? 'Yes' : 'No'}
- **Codebase review:** ${input.needsCodebaseReview ? 'Needed' : 'Not needed'}
- **Summary:** ${input.summary}
- **Next action:** ${input.nextAction}`
}
