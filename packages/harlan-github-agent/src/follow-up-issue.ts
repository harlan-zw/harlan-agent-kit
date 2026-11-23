import type { LoggedReviewFinding } from './logged-finding-pickup.ts'
import { automatedDisclosure, commitLink, findingLocation, findingNextAction, followUpRow } from './review-comment.ts'
import { cleanLine, cleanText } from './text.ts'

/**
 * Marks every issue a follow-up tick files.
 *
 * The label permits discovery of App-authored issues.
 * A matching publication receipt and unchanged content permit work without Approval.
 */
export const FOLLOW_UP_ISSUE_LABEL = 'harlan-agent-follow-up'

/** Whether one label list names an issue a follow-up tick filed. */
export function hasFollowUpIssueLabel(labels: readonly string[]): boolean {
  return labels.some(label => label.toLowerCase() === FOLLOW_UP_ISSUE_LABEL)
}

/**
 * The hidden marker that finds one finding's issue again.
 *
 * It names the finding fingerprint, so a second tick, a retry, or the same
 * finding on another pull request finds the open issue instead of filing again.
 */
export function followUpFindingMarker(fingerprint: string): string {
  return `<!-- follow-up-finding: ${fingerprint} -->`
}

/** The hidden marker for the one issue a Merged comment files for its pull request and head. */
export function mergedFollowUpsMarker(pullRequestNumber: number, headSha: string): string {
  return `<!-- merged-follow-ups: ${pullRequestNumber} ${headSha} -->`
}

export interface FollowUpIssue {
  title: string
  body: string
  marker: string
}

// GitHub refuses a title longer than 256 characters.
const maximumTitleLength = 256

function title(text: string): string {
  return cleanLine(text).replace(/\.$/, '').slice(0, maximumTitleLength)
}

/**
 * The issue one follow-up tick files.
 *
 * Issue triage reads this body without the Review's context, so it carries
 * the proof, the fix, the code at the reviewed head, and the pull request.
 */
export function followUpIssue(input: { repository: string, pullRequestNumber: number, headSha: string, finding: LoggedReviewFinding }): FollowUpIssue {
  const { finding } = input
  const location = findingLocation(input.repository, input.headSha, finding)
  const action = findingNextAction(finding.nextAction ?? '')
  const marker = followUpFindingMarker(finding.details.fingerprint)
  return {
    title: title(finding.summary),
    marker,
    body: [
      `The Review of #${input.pullRequestNumber} found this follow-up${location === '' ? '' : ` in ${location}`} at ${commitLink(input.repository, input.headSha)}. Impact \`${finding.impact}/100\`.`,
      '',
      cleanText(finding.details.proof),
      ...(action === '' ? [] : ['', `**Fix:** ${action}`]),
      '',
      marker,
      '',
      automatedDisclosure({ kind: 'issue' }),
    ].join('\n'),
  }
}

/** The one issue the Merged control files for every unfixed follow-up. */
export function mergedFollowUpsIssue(input: { repository: string, pullRequestNumber: number, headSha: string, findings: readonly LoggedReviewFinding[] }): FollowUpIssue {
  const marker = mergedFollowUpsMarker(input.pullRequestNumber, input.headSha)
  return {
    title: `Follow-ups from #${input.pullRequestNumber}`,
    marker,
    body: [
      `#${input.pullRequestNumber} merged with these follow-ups not fixed. None blocked merge.`,
      '',
      ...input.findings.map(finding => followUpRow(input.repository, input.headSha, finding)),
      '',
      `The Review read ${commitLink(input.repository, input.headSha)}.`,
      '',
      marker,
      '',
      automatedDisclosure({ kind: 'issue' }),
    ].join('\n'),
  }
}
