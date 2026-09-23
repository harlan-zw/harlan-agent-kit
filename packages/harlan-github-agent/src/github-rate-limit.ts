import type { GitHubTokenProvider } from './github-auth.ts'
import { RequestError } from 'octokit'
import { err } from './result.ts'

/**
 * Makes every Octokit client fail on a rate limit instead of sleeping.
 *
 * The `octokit` default retries once after the reset, which is up to an hour
 * away. That sleep ignores the request's abort signal, so a poll pass sat on it
 * until the pass timeout abandoned it, 86 times between 2026-09-19 and
 * 2026-09-23. The gate below holds the quota instead, visibly.
 */
export const failFastThrottle = {
  onRateLimit: () => false,
  onSecondaryRateLimit: () => false,
}

/** The GitHub quota a credential spends. */
export type GitHubQuota
  = | { _tag: 'Installation', owner: string }
    | { _tag: 'User', login: string }

/** One rate limit GitHub reported, parsed from its response. */
export type GitHubRateLimit
  = | { _tag: 'Primary', resetAt: Date }
    | { _tag: 'Secondary', retryAfterSeconds: number }

/** GitHub's fallback wait when a secondary limit names no delay. */
const SECONDARY_FALLBACK_SECONDS = 60

/** Reads a rate limit out of a rejected request, or null for any other failure. */
export function parseRateLimit(error: unknown): GitHubRateLimit | null {
  if (!(error instanceof RequestError) || (error.status !== 403 && error.status !== 429))
    return null
  const headers = error.response?.headers ?? {}
  const reset = Number(headers['x-ratelimit-reset'])
  if (headers['x-ratelimit-remaining'] === '0' && Number.isFinite(reset) && reset > 0)
    return { _tag: 'Primary', resetAt: new Date(reset * 1000) }
  const retryAfter = Number(headers['retry-after'])
  if (headers['retry-after'] !== undefined || headers['x-ratelimit-remaining'] === '0'
    || error.status === 429 || /\b(?:rate limits?|abuse detection)\b/i.test(error.message)) {
    return { _tag: 'Secondary', retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : SECONDARY_FALLBACK_SECONDS }
  }
  return null
}

function quotaKey(quota: GitHubQuota): string {
  return quota._tag === 'Installation' ? `installation:${quota.owner.toLowerCase()}` : `user:${quota.login.toLowerCase()}`
}

function quotaName(quota: GitHubQuota): string {
  return quota._tag === 'Installation' ? `The App installation on ${quota.owner}` : `The GitHub account ${quota.login}`
}

interface Hold {
  quota: GitHubQuota
  kind: GitHubRateLimit['_tag']
  until: Date
}

function holdMessage(hold: Hold): string {
  const limit = hold.kind === 'Primary' ? 'the primary GitHub rate limit' : 'a secondary GitHub rate limit'
  return `${quotaName(hold.quota)} hit ${limit}. Requests pause until ${hold.until.toISOString()}.`
}

export interface GitHubRateLimitGate {
  /**
   * Refuses a credential while its quota is held.
   *
   * Every GitHub request needs a credential first, so a held quota spends no
   * request at all until GitHub resets it.
   */
  guard: (source: GitHubTokenProvider, quotaFor: (repository: string) => GitHubQuota) => GitHubTokenProvider
  /** One message per quota that is held now, for the System pane. */
  active: () => string[]
}

export function createGitHubRateLimitGate(options: { now: () => Date }): GitHubRateLimitGate {
  const holds = new Map<string, Hold>()
  const current = (): Hold[] => {
    const now = options.now().getTime()
    for (const [key, hold] of holds) {
      if (hold.until.getTime() < now)
        holds.delete(key)
    }
    return [...holds.values()]
  }
  return {
    guard: (source, quotaFor) => ({
      getToken(repository, access, signal) {
        const hold = current().find(candidate => quotaKey(candidate.quota) === quotaKey(quotaFor(repository)))
        return hold === undefined
          ? source.getToken(repository, access, signal)
          : Promise.resolve(err({ repository, message: holdMessage(hold) }))
      },
      invalidate: (repository, access) => source.invalidate(repository, access),
      rateLimited(repository, limit) {
        const quota = quotaFor(repository)
        const until = limit._tag === 'Primary'
          ? limit.resetAt
          : new Date(options.now().getTime() + limit.retryAfterSeconds * 1000)
        const existing = holds.get(quotaKey(quota))
        if (existing === undefined || existing.until < until)
          holds.set(quotaKey(quota), { quota, kind: limit._tag, until })
      },
    }),
    active: () => current().map(holdMessage),
  }
}
