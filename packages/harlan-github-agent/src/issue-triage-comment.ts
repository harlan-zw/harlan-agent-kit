import type { IssueTriageResult } from './issue-triage.ts'
import type { StatusDot } from './review-comment.ts'
import { issueTriageStateLabel } from './issue-triage.ts'
import { automatedDisclosure, statusLine } from './review-comment.ts'

export const AUTOMATED_ISSUE_TRIAGE_MARKER = '<!-- harlan-agent-kit:issue-triage -->'

const routeDots: Record<IssueTriageResult['_tag'], StatusDot> = {
  READY_TO_IMPLEMENT: 'ready',
  READY_TO_SPEC: 'ready',
  NEEDS_INFO: 'act',
  WAIT_TO_IMPLEMENT: 'work',
}

/**
 * The canonical triage comment, written to the person who opened the issue.
 *
 * The route and both scores lead. The plan for the implementing Agent folds,
 * because it helps that Agent and not the reporter. A duplicate points at the
 * issue that carries the fix.
 */
export function issueTriageComment(input: IssueTriageResult): string {
  const footer = automatedDisclosure({ kind: 'triage', disclaimer: 'not Harlan\'s commitment' })
  if (input.duplicateIssue !== null) {
    const number = input.duplicateIssue.number
    return [
      AUTOMATED_ISSUE_TRIAGE_MARKER,
      statusLine('work', `Duplicate of #${number}`),
      '',
      `${input.duplicateIssue.reason.replace(/[.!?]?$/, '.')} Follow #${number} for the fix.`,
      '',
      ...(input.relatedPullRequests.length === 0 ? [] : [...input.relatedPullRequests.map(reference => `- #${reference.number}: ${reference.reason}`), '']),
      footer,
    ].join('\n')
  }
  if (input._tag === 'NEEDS_INFO') {
    return [
      AUTOMATED_ISSUE_TRIAGE_MARKER,
      statusLine('act', 'Needs info'),
      '',
      input.summary,
      '',
      'Add these to move it forward:',
      '',
      // Evidence stored before the list existed asks with its next action.
      ...(input.ask.length === 0 ? [input.nextAction] : input.ask.map(item => `- ${item}`)),
      '',
      footer,
    ].join('\n')
  }
  const references = [
    ...(input.relatedIssues.length === 0 ? [] : [`- Fix with: ${input.relatedIssues.map(number => `#${number}`).join(', ')}`]),
    ...input.relatedPullRequests.map(reference => `- #${reference.number}: ${reference.reason}`),
  ]
  return [
    AUTOMATED_ISSUE_TRIAGE_MARKER,
    statusLine(routeDots[input._tag], issueTriageStateLabel(input._tag), `difficulty \`${input.difficulty}/5\` · impact \`${input.impact}/5\``),
    '',
    input.summary,
    '',
    '<details><summary>Plan for the implementing agent</summary>',
    '',
    input.nextAction,
    '',
    `Reproduction: ${input.hasReproduction ? 'yes' : 'no'}. Codebase review: ${input.needsCodebaseReview ? 'needed' : 'not needed'}.`,
    ...(references.length === 0 ? [] : ['', ...references]),
    '',
    '</details>',
    '',
    footer,
  ].join('\n')
}
