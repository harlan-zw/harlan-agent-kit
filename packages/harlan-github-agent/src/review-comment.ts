export const AUTOMATED_REVIEW_MARKER = '<!-- harlan-agent-kit:pr-triage -->'
/** The login the GitHub App posts as. */
export const AGENT_ACTOR_LOGIN = 'harlan-github-agent[bot]'

const AGENT_LINK = '[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit)'
const POLICY_LINK = '[AI open source policy](https://harlanzw.com/blog/ai-in-open-source)'

export interface AutomatedDisclosure {
  /** What this comment is, as one noun. The reader sees it in the first sentence. */
  kind: 'review' | 'repair update' | 'status' | 'triage'
  /** Says the comment is not Harlan speaking, where a reader could take it that way. */
  disclaimer?: string
  /** Sentences after the policy link, before the timestamp. */
  notes?: string[]
  /** Absent on a comment that carries no timestamp, so an unchanged body writes nothing. */
  updatedAt?: string
}

/**
 * The disclosure line every automated comment carries.
 *
 * Eight templates wrote eight versions of this sentence, under two different
 * names for the same bot, and one of them linked no policy at all. A reader
 * cannot tell one bot from two. One function means one name and one wording.
 */
export function automatedDisclosure(input: AutomatedDisclosure): string {
  return `> ${[
    `${AGENT_LINK} posted this automated ${input.kind}.`,
    ...(input.disclaimer === undefined ? [] : [input.disclaimer]),
    `${POLICY_LINK}.`,
    ...(input.notes ?? []),
    ...(input.updatedAt === undefined ? [] : [`Last updated: ${input.updatedAt}.`]),
  ].join(' ')}`
}

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

interface ReviewWorkflowState {
  _tag: 'Review'
  headSha: string
  baseSha: string
  outcome: 'READY' | 'PENDING' | 'BLOCKED'
}

interface ReviewSkippedWorkflowState {
  _tag: 'ReviewSkipped'
  headSha: string
  baseSha: string
}

type AutomatedReviewWorkflowState = ReviewWorkflowState | ReviewSkippedWorkflowState

function automatedReviewWorkflowState(body: string): AutomatedReviewWorkflowState | undefined {
  const encoded = body.match(/<!-- workflow-state: (\{[^\n]+\}) -->/)?.[1]
  if (encoded === undefined)
    return undefined
  let value: unknown
  try {
    value = JSON.parse(encoded)
  }
  catch {
    // GitHub comment text is untrusted. A malformed marker carries no state.
    return undefined
  }
  if (typeof value !== 'object' || value === null || !('_tag' in value) || !('headSha' in value) || !('baseSha' in value))
    return undefined
  if (typeof value.headSha !== 'string' || typeof value.baseSha !== 'string')
    return undefined
  if (value._tag === 'ReviewSkipped')
    return { _tag: value._tag, headSha: value.headSha, baseSha: value.baseSha }
  if (value._tag !== 'Review' || !('outcome' in value) || !['READY', 'PENDING', 'BLOCKED'].includes(String(value.outcome)))
    return undefined
  return {
    _tag: value._tag,
    headSha: value.headSha,
    baseSha: value.baseSha,
    outcome: value.outcome as ReviewWorkflowState['outcome'],
  }
}

export function automatedReviewHead(body: string): string | undefined {
  const current = body.match(/<!-- reviewed-sha: ([a-f\d]{40,64}) -->/i)?.[1]
  if (current !== undefined)
    return current
  return body.match(/^- Reviewed `([a-f\d]{40,64})` against /im)?.[1]
}

function reviewState(body: string): 'active' | 'complete' {
  return /^### 🤖 (?:READY|BLOCKED|REVIEW SKIPPED)\b/m.test(body)
    || /^\*\*(?:PASS|PENDING|BLOCKED)\b/m.test(body)
    ? 'complete'
    : 'active'
}

export function priorAutomatedReviewForHead(
  comments: AutomatedReviewComment[],
  headSha: string,
  currentAgentLogin: string,
  baseSha?: string,
): PriorAutomatedReview {
  const currentAgent = currentAgentLogin.toLowerCase()
  const found = comments.findLast((comment) => {
    if (!comment.body.includes(AUTOMATED_REVIEW_MARKER) || automatedReviewHead(comment.body)?.toLowerCase() !== headSha.toLowerCase())
      return false
    if (comment.authorLogin.toLowerCase() !== currentAgent)
      return trustedAssociations.has(comment.authorAssociation.toUpperCase())
    const workflow = automatedReviewWorkflowState(comment.body)
    if (workflow === undefined || workflow.headSha.toLowerCase() !== headSha.toLowerCase() || (baseSha !== undefined && workflow.baseSha.toLowerCase() !== baseSha.toLowerCase()))
      return false
    return workflow._tag === 'ReviewSkipped' || workflow.outcome !== 'PENDING'
  })

  return found === undefined
    ? { _tag: 'None' }
    : {
        _tag: 'Found',
        authorLogin: found.authorLogin,
        state: reviewState(found.body),
        url: found.url,
      }
}
