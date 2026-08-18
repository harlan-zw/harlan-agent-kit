/**
 * One taxonomy for every failure the controller can observe.
 *
 * The controller used to recover a Task by matching its reason against a list
 * of exact strings collected from past incidents. Every new transient error
 * therefore became a permanently dead Task until someone added its wording.
 * Failures are classified by what they say about the world instead, so an
 * error nobody has seen yet still retries.
 */
export type FailureClass
  /** The world was briefly wrong. The same work can succeed unchanged. */
  = | { _tag: 'Transient', kind: TransientKind }
    /** The work cannot succeed until a person or a policy changes. */
    | { _tag: 'Permanent', kind: PermanentKind }

export type TransientKind
  = | 'github_unavailable'
    | 'github_access'
    /**
     * The GitHub App installation does not hold the permission the work needs.
     *
     * Transient because a person can grant it, and the Task then succeeds
     * unchanged. It is deliberately absent from the outage kinds a healthy
     * GitHub gives budget back to, so the retry is bounded: a repository that
     * polls fine while its installation stays narrow cannot refill this budget.
     */
    | 'installation_access'
    | 'rate_limit'
    | 'network'
    | 'agent_provider'
    | 'controller'
    | 'subject_changed'
    | 'agent_result'

export type PermanentKind
  = | 'policy'
    | 'unknown'

export interface FailureSignal {
  message: string
  status?: number | undefined
}

/**
 * Reasons the controller refuses to publish a repair one review already made.
 *
 * They live here, beside the taxonomy, so a refusal cannot be worded into the
 * Transient patterns below. A review repair exists only in the review worktree,
 * and one refused repair used to requeue the review, spend a whole agent turn
 * reading the same policy, and refuse again.
 */
export const REVIEW_REPAIR_REFUSALS = {
  approval: 'This pull request needs Approval before the controller publishes a repair.',
  branch: 'The controller cannot write this pull request branch.',
  cancelled: 'A person cancelled the repair for this pull request head commit.',
  closed: 'The pull request closed before the review published its repair.',
  conflict: 'The pull request has a merge conflict, so the review cannot publish its repair.',
  draft: 'The pull request is still draft, so the review cannot publish its repair.',
  owned: 'Another repair Task already owns this pull request head commit.',
  policy: 'Repository policy does not authorize an automated repair.',
  published: 'This pull request head commit already has a published repair.',
} as const

/**
 * Reasons the controller itself produces for a state it refuses to act on.
 *
 * These never change on their own, so retrying one only burns an agent turn.
 */
const permanentMessages = new Set<string>([
  ...Object.values(REVIEW_REPAIR_REFUSALS),
  'Repository policy does not authorize an automated review comment.',
  'Repository policy does not permit issue work.',
  'This pull request does not require local approval.',
])

/**
 * Kept deliberately narrow.
 *
 * A broad "policy" match would swallow reasons that describe a state the next
 * poll changes, such as a Baseline repair that is not authorized for a base
 * commit yet, and those must keep retrying.
 */
const permanentPatterns: RegExp[] = [
  /\bis still draft\b/i,
]

/** GitHub answers a healthy request this way while it is degraded or replicating. */
const githubUnavailablePatterns: RegExp[] = [
  /\bno server is currently available\b/i,
  /\bcould not resolve to a node\b/i,
  /\bserver error\b/i,
  /\bbad gateway\b/i,
  /\bservice unavailable\b/i,
  /\bgateway timeout\b/i,
  /\binternal server error\b/i,
]

/**
 * GitHub says this when the installation itself does not hold the permission.
 *
 * Separated from the access patterns below because only a person fixes it. A
 * healthy poll proves nothing about a narrow installation, so this kind is left
 * out of the outage kinds that win their recovery budget back.
 */
const installationAccessPatterns: RegExp[] = [
  /\bpermissions requested are not granted to this installation\b/i,
]

/**
 * An installation token can answer a request it is entitled to with a reject
 * while GitHub is degraded, so access rejects retry rather than kill the Task.
 *
 * Proven on 2026-08-17: for 105 minutes GitHub rejected calls the token
 * provably covered, including `pulls.list` under a `pull_requests: read` grant,
 * and minted tokens scoped below the request. The same calls passed before and
 * after. Only the installation message above survives a retry unchanged.
 */
const githubAccessPatterns: RegExp[] = [
  /\bresource not accessible by integration\b/i,
  /\bgranted less access than\b/i,
  /\bbad credentials\b/i,
  /\bauthentication error\b/i,
  /\brequires authentication\b/i,
  /\bnot found\b/i,
]

const rateLimitPatterns: RegExp[] = [
  /\brate limit\b/i,
  /\bquota exhausted\b/i,
  /\bsecondary rate\b/i,
  /\babuse detection\b/i,
  /\btoo many requests\b/i,
]

const networkPatterns: RegExp[] = [
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bETIMEDOUT\b/,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bEPIPE\b/,
  /\bEHOSTUNREACH\b/,
  /\bENETUNREACH\b/,
  /\bsocket hang up\b/i,
  /\bfetch failed\b/i,
  /\bnetwork\b.+\berror\b/i,
  /\brequest\b.+\btimed out\b/i,
  /\bThe operation was aborted\b/i,
  /\bAbortError\b/,
]

/** The agent process died, stalled, or never answered. Its work can be redone. */
const agentProviderPatterns: RegExp[] = [
  /\bstopped sending output\b/i,
  /\bsession exited with code\b/i,
  /\bsession was stopped by\b/i,
  /\bsession failed\b/i,
  /\bfinished without a result\b/i,
  /\bspawn\b.+\bENOENT\b/,
  /\bmodel\b.+\boverloaded\b/i,
  /\bcontext\b.+\blength\b/i,
]

/**
 * The controller lost a race with itself. The next pass starts from a clean state.
 *
 * A race is the only thing that belongs here. "Could not be claimed" used to
 * match, which made every refusal that borrowed those words retry forever.
 */
const controllerPatterns: RegExp[] = [
  /\balready has a different publication command\b/i,
  /\blease changed before completion\b/i,
  /\bno longer assigned\b/i,
  /\bnot all refs are readable\b/i,
  /\bcould not list wt worktrees\b/i,
  /\bcould not read the conflict resolution patch\b/i,
  /\bpatch digest does not match\b/i,
  /\bnot authorize Baseline repair\b/i,
  /\bcould not be queued\b/i,
]

/** The pull request or issue moved while the controller worked on it. */
const subjectChangedPatterns: RegExp[] = [
  /\bchanged before\b/i,
  /\bno longer matches\b/i,
  /\bRefresh before\b/i,
  /\bwas replaced\b/i,
]

/** The agent answered in the wrong shape. The work behind the answer is redoable. */
const agentResultPatterns: RegExp[] = [
  /\breturned an invalid\b/i,
  /\breturned malformed\b/i,
  /\bomitted confidence\b/i,
]

function matches(patterns: RegExp[], message: string): boolean {
  return patterns.some(pattern => pattern.test(message))
}

/**
 * Classifies one failure.
 *
 * An unrecognised failure is Permanent on purpose. A Transient default would
 * retry a genuine defect forever and hide it behind a retry counter, while a
 * Permanent default surfaces it as an Incident a person can read and name.
 */
export function classifyFailure(signal: FailureSignal): FailureClass {
  const message = signal.message

  if (permanentMessages.has(message.trim()) || matches(permanentPatterns, message))
    return { _tag: 'Permanent', kind: 'policy' }

  if (signal.status === 429 || matches(rateLimitPatterns, message))
    return { _tag: 'Transient', kind: 'rate_limit' }
  if (signal.status !== undefined && signal.status >= 500)
    return { _tag: 'Transient', kind: 'github_unavailable' }
  if (matches(githubUnavailablePatterns, message))
    return { _tag: 'Transient', kind: 'github_unavailable' }
  // Matched before the access patterns, because GitHub returns this with a 403
  // and the wider access patterns would otherwise swallow it.
  if (matches(installationAccessPatterns, message))
    return { _tag: 'Transient', kind: 'installation_access' }
  if (signal.status === 401 || signal.status === 403 || matches(githubAccessPatterns, message))
    return { _tag: 'Transient', kind: 'github_access' }
  if (matches(networkPatterns, message))
    return { _tag: 'Transient', kind: 'network' }
  // Controller failures are matched before provider failures so a missing
  // Worktrunk binary reads as controller tooling and not as a broken agent.
  if (matches(controllerPatterns, message))
    return { _tag: 'Transient', kind: 'controller' }
  if (matches(agentProviderPatterns, message))
    return { _tag: 'Transient', kind: 'agent_provider' }
  if (matches(agentResultPatterns, message))
    return { _tag: 'Transient', kind: 'agent_result' }
  if (matches(subjectChangedPatterns, message))
    return { _tag: 'Transient', kind: 'subject_changed' }

  return { _tag: 'Permanent', kind: 'unknown' }
}

export function isTransientFailure(signal: FailureSignal): boolean {
  return classifyFailure(signal)._tag === 'Transient'
}

/**
 * Whether another attempt at the same work can change the result.
 *
 * A Task the controller refused by policy reads the same policy on every
 * attempt, and each attempt costs one whole agent turn, so it never runs again.
 * An unclassified failure keeps its attempts, because "unknown" does not say
 * that the world stood still.
 */
export function mayRetryFailure(signal: FailureSignal): boolean {
  const failure = classifyFailure(signal)
  return failure._tag !== 'Permanent' || failure.kind !== 'policy'
}

/** How many times the controller requeues a Failed Task before it waits for a person. */
export const MAXIMUM_RECOVERY_ATTEMPTS = 5

const baseRecoveryDelayMilliseconds = 60_000
const maximumRecoveryDelayMilliseconds = 30 * 60_000

/**
 * Returns how long a Failed Task waits before it may be requeued.
 *
 * The first recovery is immediate, because most transient failures have already
 * passed by the time the controller notices. Later ones back off so a
 * repository GitHub keeps rejecting cannot spend the whole agent pool on one
 * Task, and stop entirely once the budget is gone.
 */
export function recoveryDelayMilliseconds(recoveryAttempts: number): number {
  if (recoveryAttempts <= 0)
    return 0
  return Math.min(
    baseRecoveryDelayMilliseconds * 2 ** (recoveryAttempts - 1),
    maximumRecoveryDelayMilliseconds,
  )
}

export function nextRecoveryAt(failedAt: string, recoveryAttempts: number): string {
  return new Date(Date.parse(failedAt) + recoveryDelayMilliseconds(recoveryAttempts)).toISOString()
}
