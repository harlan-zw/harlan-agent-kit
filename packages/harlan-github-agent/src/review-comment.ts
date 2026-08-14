export const AUTOMATED_REVIEW_MARKER = '<!-- harlan-agent-kit:pr-triage -->'

export type PriorAutomatedReview
  = | { _tag: 'None' }
    | {
      _tag: 'Found'
      authorLogin: string
      state: 'active' | 'complete'
      url: string
    }

export interface AutomatedReviewComment {
  authorAssociation: string
  authorLogin: string
  body: string
  url: string
}

const trustedAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

export function automatedReviewHead(body: string): string | undefined {
  const current = body.match(/<!-- reviewed-sha: ([a-f\d]{40,64}) -->/i)?.[1]
  if (current !== undefined)
    return current
  return body.match(/^- Reviewed `([a-f\d]{40,64})` against /im)?.[1]
}

function reviewState(body: string): 'active' | 'complete' {
  return /^### 🤖 (?:READY|WAITING|BLOCKED)\b/m.test(body)
    || /^\*\*(?:PASS|PENDING|BLOCKED)\b/m.test(body)
    ? 'complete'
    : 'active'
}

export function priorAutomatedReviewForHead(
  comments: AutomatedReviewComment[],
  headSha: string,
  currentAgentLogin: string,
): PriorAutomatedReview {
  const found = comments.findLast(comment =>
    comment.authorLogin.toLowerCase() !== currentAgentLogin.toLowerCase()
    && trustedAssociations.has(comment.authorAssociation.toUpperCase())
    && comment.body.includes(AUTOMATED_REVIEW_MARKER)
    && automatedReviewHead(comment.body)?.toLowerCase() === headSha.toLowerCase())

  return found === undefined
    ? { _tag: 'None' }
    : {
        _tag: 'Found',
        authorLogin: found.authorLogin,
        state: reviewState(found.body),
        url: found.url,
      }
}
