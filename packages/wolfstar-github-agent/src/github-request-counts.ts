import type { GitHubTokenProvider } from './github-auth.ts'
import type { GitHubQuota } from './github-rate-limit.ts'
import { createHash } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'

interface RequestData {
  origin: string | URL
  path: string
  method: string
  headers: string[]
}

type Credential = GitHubQuota | { _tag: 'Unauthenticated' } | { _tag: 'Unidentified' }
type RateLimit =
  | { _tag: 'Unavailable' }
  | { _tag: 'Available'; resource: string; remaining: number; used: number; resetAt: number }
interface RequestCounts {
  credential: Credential
  repository: string | null
  endpoint: string
  method: string
  completed: number
  conditional: number
  notModified: number
  errors: number
  statuses: Record<number, number>
  rateLimit: RateLimit
}
export interface GitHubRequestCountsReport {
  from: string
  to: string
  completed: number
  overflow: number
  rows: RequestCounts[]
}

// Retain route words only. Refs, file paths, IDs, queries, and bodies never become log data.
const routeWords = new Set([
  'repos',
  'user',
  'users',
  'orgs',
  'app',
  'installation',
  'installations',
  'repositories',
  'access_tokens',
  'pulls',
  'issues',
  'comments',
  'reviews',
  'files',
  'commits',
  'compare',
  'merge',
  'labels',
  'check-runs',
  'check-suites',
  'statuses',
  'status',
  'actions',
  'runs',
  'jobs',
  'logs',
  'artifacts',
  'branches',
  'git',
  'ref',
  'refs',
  'tags',
  'contents',
  'releases',
  'latest',
  'assets',
  'deployments',
  'events',
  'search',
  'code',
  'graphql',
  'rate_limit',
  'requested_reviewers',
  'reactions',
  'timeline',
  'workflow',
  'workflows',
  'dispatches',
  'permissions',
  'collaborators',
])
const fingerprint = (token: string): string => createHash('sha256').update(token).digest('hex')

function requestData(message: unknown): RequestData | null {
  if (typeof message !== 'object' || message === null || !('request' in message)) return null
  const request = message.request
  if (
    typeof request !== 'object' ||
    request === null ||
    !('origin' in request) ||
    !(typeof request.origin === 'string' || request.origin instanceof URL) ||
    !('path' in request) ||
    typeof request.path !== 'string' ||
    !('method' in request) ||
    typeof request.method !== 'string' ||
    !('headers' in request) ||
    !Array.isArray(request.headers) ||
    !request.headers.every((header) => typeof header === 'string') ||
    request.headers.length % 2 !== 0
  ) {
    return null
  }
  return request as RequestData
}

function header(headers: readonly string[], name: string): string | undefined {
  for (let index = 0; index < headers.length; index += 2) {
    if (headers[index]?.toLowerCase() === name) return headers[index + 1]
  }
}

function rateLimit(message: unknown): RateLimit {
  if (typeof message !== 'object' || message === null || !('response' in message)) return { _tag: 'Unavailable' }
  const response = message.response
  if (typeof response !== 'object' || response === null || !('headers' in response)) {
    return { _tag: 'Unavailable' }
  }
  const rawHeaders = response.headers
  const headers: string[] = []
  if (Array.isArray(rawHeaders)) {
    if (
      rawHeaders.length % 2 !== 0 ||
      !rawHeaders.every((value) => typeof value === 'string' || value instanceof Uint8Array)
    )
      return { _tag: 'Unavailable' }
    headers.push(...rawHeaders.map((value) => (typeof value === 'string' ? value : Buffer.from(value).toString())))
  } else if (typeof rawHeaders === 'object' && rawHeaders !== null) {
    for (const [name, value] of Object.entries(rawHeaders)) {
      if (typeof value === 'string') headers.push(name, value)
    }
  } else {
    return { _tag: 'Unavailable' }
  }
  const resource = header(headers, 'x-ratelimit-resource')
  const remainingText = header(headers, 'x-ratelimit-remaining')
  const usedText = header(headers, 'x-ratelimit-used')
  const resetText = header(headers, 'x-ratelimit-reset')
  if (
    resource === undefined ||
    !/^[a-z_]{1,40}$/.test(resource) ||
    [remainingText, usedText, resetText].some((value) => value === undefined || !/^\d{1,12}$/.test(value))
  ) {
    return { _tag: 'Unavailable' }
  }
  return {
    _tag: 'Available',
    resource,
    remaining: Number(remainingText),
    used: Number(usedText),
    resetAt: Number(resetText),
  }
}

/** Count completed transport requests, including retries and GitHub's actual 304 responses. */
export function createGitHubRequestCounts(options: {
  now: () => Date
  report: (report: GitHubRequestCountsReport) => void
  origin?: string
  maxGroups?: number
  intervalMilliseconds?: number
}) {
  const origin = options.origin ?? 'https://api.github.com'
  const maxGroups = Math.min(1024, Math.max(1, options.maxGroups ?? 512))
  const credentials = new Map<string, GitHubQuota>()
  const groups = new Map<string, RequestCounts>()
  let seen = new WeakSet<object>()
  let completed = 0
  let overflow = 0
  let from = options.now().toISOString()
  let interval: ReturnType<typeof setInterval> | undefined
  let active = false

  const flush = (): void => {
    if (completed === 0) return
    const to = options.now().toISOString()
    // The journal truncates large log lines. Each chunk is a complete report with additive totals.
    let batch: GitHubRequestCountsReport = { from, to, completed: overflow, overflow, rows: [] }
    const emit = (): void => {
      if (batch.completed > 0) options.report(batch)
      batch = { from, to, completed: 0, overflow: 0, rows: [] }
    }
    for (const row of [...groups.values()].sort((left, right) => right.completed - left.completed)) {
      const single = { from, to, completed: row.completed, overflow: 0, rows: [row] }
      if (Buffer.byteLength(JSON.stringify(single)) > 16_384) {
        emit()
        batch.completed = row.completed
        batch.overflow = row.completed
        emit()
        continue
      }
      const candidate = { ...batch, completed: batch.completed + row.completed, rows: [...batch.rows, row] }
      if (Buffer.byteLength(JSON.stringify(candidate)) > 16_384) emit()
      batch.completed += row.completed
      batch.rows.push(row)
    }
    emit()
    groups.clear()
    completed = 0
    overflow = 0
    from = to
  }
  const observe = (message: unknown): void => {
    const request = requestData(message)
    if (request === null || String(request.origin) !== origin || seen.has(request)) return
    seen.add(request)
    completed++
    const authorization = header(request.headers, 'authorization')
    const token = authorization?.match(/^(?:bearer|token) (\S+)$/i)?.[1]
    const credential: Credential =
      authorization === undefined
        ? { _tag: 'Unauthenticated' }
        : token === undefined
          ? { _tag: 'Unidentified' }
          : (credentials.get(fingerprint(token)) ?? { _tag: 'Unidentified' })
    const segments = request.path.split('?')[0]!.split('/').filter(Boolean)
    const repository =
      segments[0] === 'repos' &&
      segments.length >= 3 &&
      segments.slice(1, 3).every((segment) => /^[\w.-]{1,100}$/.test(segment))
        ? `${segments[1]}/${segments[2]}`
        : null
    const endpoint = `/${segments.map((segment, index) => (repository !== null && index === 1 ? ':owner' : repository !== null && index === 2 ? ':repo' : routeWords.has(segment) ? segment : ':value')).join('/')}`
    const method = /^[A-Z]{1,10}$/.test(request.method) ? request.method : 'UNKNOWN'
    const key = JSON.stringify([credential, repository, endpoint, method])
    let row = groups.get(key)
    if (row === undefined) {
      if (groups.size >= maxGroups) {
        overflow++
        return
      }
      row = {
        credential,
        repository,
        endpoint,
        method,
        completed: 0,
        conditional: 0,
        notModified: 0,
        errors: 0,
        statuses: {},
        rateLimit: { _tag: 'Unavailable' },
      }
      groups.set(key, row)
    }
    row.completed++
    if (
      header(request.headers, 'if-none-match') !== undefined ||
      header(request.headers, 'if-modified-since') !== undefined
    )
      row.conditional++
    const response = typeof message === 'object' && message !== null && 'response' in message ? message.response : null
    const status =
      typeof response === 'object' &&
      response !== null &&
      'statusCode' in response &&
      typeof response.statusCode === 'number'
        ? response.statusCode
        : null
    if (status === null) {
      row.errors++
    } else {
      row.statuses[status] = (row.statuses[status] ?? 0) + 1
      if (status === 304) row.notModified++
      const limit = rateLimit(message)
      if (limit._tag === 'Available') row.rateLimit = limit
    }
  }
  const headersChannel = channel('undici:request:headers')
  const errorChannel = channel('undici:request:error')
  return {
    tokens(source: GitHubTokenProvider, quota: (repository: string) => GitHubQuota): GitHubTokenProvider {
      return {
        ...source,
        async getToken(repository, access, signal) {
          const result = await source.getToken(repository, access, signal)
          if (result._tag === 'Ok') {
            const key = fingerprint(result.value.token)
            credentials.delete(key)
            if (credentials.size >= 2048) credentials.delete(credentials.keys().next().value!)
            credentials.set(key, quota(repository))
          }
          return result
        },
      }
    },
    flush,
    start() {
      if (active) return
      active = true
      from = options.now().toISOString()
      headersChannel.subscribe(observe)
      errorChannel.subscribe(observe)
      interval = setInterval(flush, options.intervalMilliseconds ?? 60_000)
      interval.unref()
    },
    stop() {
      if (!active) return
      active = false
      clearInterval(interval)
      headersChannel.unsubscribe(observe)
      errorChannel.unsubscribe(observe)
      flush()
      seen = new WeakSet()
    },
  }
}
