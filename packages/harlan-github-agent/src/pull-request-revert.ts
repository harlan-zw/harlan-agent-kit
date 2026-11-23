/** What a revert pull request says it reverts. */
export type RevertTarget
  = | { _tag: 'PullRequest', number: number }
    /** A merge or squash commit on the base branch, from `git revert`. */
    | { _tag: 'Commit', sha: string }

/** GitHub's Revert button writes this line into the pull request body. */
const REVERTS_LINE = /^Reverts\s+([\w.-]+\/[\w.-]+)?#(\d+)\b/im

/** `git revert` writes this line into the commit message, and a pull request often copies it. */
const REVERTS_COMMIT = /^This reverts commit ([0-9a-f]{40})\b/im

/**
 * A title whose first word is revert: `Revert "…"`, `revert: …`, or a
 * Conventional Commits subject such as `chore: revert …`. A compound word or a
 * later word, such as `revert-safe` or `count reverts`, never matches.
 */
const REVERT_TITLE = /^(?:revert(?:\([^)]*\))?!?:|(?:[a-z]+(?:\([^)]*\))?!?:\s*)?revert(?=[\s"':]|$))/i

/**
 * The pull request or commit a revert names, or null when it names none or more than one.
 *
 * Read the shapes found in default branch history: GitHub's Revert button,
 * `git revert`, and a title that names one pull request. Prose that only
 * mentions a revert never counts, because a wrong match blames a Review run.
 *
 * An exact line wins over the title. A `git revert` title quotes the original
 * subject, and that subject can name an unrelated issue or pull request.
 */
export function revertTarget(input: { repository: string, title: string, body: string }): RevertTarget | null {
  const button = REVERTS_LINE.exec(input.body)
  if (button !== null) {
    const repository = button[1]
    return repository === undefined || repository.toLowerCase() === input.repository.toLowerCase()
      ? { _tag: 'PullRequest', number: Number(button[2]) }
      : null
  }
  const commit = REVERTS_COMMIT.exec(input.body)
  if (commit !== null)
    return { _tag: 'Commit', sha: commit[1]! }
  if (!REVERT_TITLE.test(input.title))
    return null
  const numbers = new Set([...input.title.matchAll(/#(\d+)\b/g)].map(match => Number(match[1])))
  return numbers.size === 1 ? { _tag: 'PullRequest', number: [...numbers][0]! } : null
}
