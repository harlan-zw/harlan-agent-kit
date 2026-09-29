import type { IssueTriageResult } from './issue-triage.ts'
import { issueTriageStateLabel } from './issue-triage.ts'
import { automatedDisclosure } from './review-comment.ts'

export const AUTOMATED_ISSUE_TRIAGE_MARKER = '<!-- harlan-agent-kit:issue-triage -->'

export function issueTriageComment(input: IssueTriageResult): string {
  const references = [
    ...(input.relatedIssues.length === 0 ? [] : [`- **Fix with:** ${input.relatedIssues.map(number => `#${number}`).join(', ')}`]),
    ...(input.duplicateIssue === null ? [] : [`- **Duplicate of:** #${input.duplicateIssue.number}: ${input.duplicateIssue.reason}`]),
    ...(input.relatedPullRequests.length === 0 ? [] : [`- **Related pull requests:** ${input.relatedPullRequests.map(reference => `#${reference.number}: ${reference.reason}`).join('; ')}`]),
  ]
  return `${AUTOMATED_ISSUE_TRIAGE_MARKER}
### 🤖 ISSUE TRIAGE

${automatedDisclosure({ kind: 'triage', disclaimer: `It is not Harlan's personal assessment or commitment.` })}

- **Route:** ${issueTriageStateLabel(input._tag)}
- **Difficulty:** ${input.difficulty}/5
- **Impact:** ${input.impact}/5
- **Reproduction:** ${input.hasReproduction ? 'Yes' : 'No'}
- **Codebase review:** ${input.needsCodebaseReview ? 'Needed' : 'Not needed'}
- **Summary:** ${input.summary}
- **Next action:** ${input.nextAction}${references.length === 0 ? '' : `\n${references.join('\n')}`}`
}
