import type { Result, TaskFailure } from './types.ts'
import { Buffer } from 'node:buffer'
import { createSign } from 'node:crypto'
import { err, ok } from './types.ts'

export type GitHubAccess = 'read' | 'comment' | 'review' | 'check'
export interface GitHubCredential { token: string, expiresAt: string, installationId: number }
export interface GitHubAppIdentity { id: number, slug: string }
export interface GitHubAppAuth {
  appId: number
  token: (repository: string, access: GitHubAccess, signal?: AbortSignal) => Promise<Result<GitHubCredential>>
  identity: (signal?: AbortSignal) => Promise<Result<GitHubAppIdentity>>
  invalidate: (repository: string, access: GitHubAccess) => void
}

export function parseRepositoryName(repository: string): Result<{ owner: string, name: string }> {
  const match = /^([a-z0-9][a-z0-9-]*)\/([\w.-]+)$/i.exec(repository)
  return match && !['.', '..'].includes(match[2]!)
    ? ok({ owner: match[1]!, name: match[2]! })
    : err({ _tag: 'Configuration', message: 'Use a repository name in owner/name form.' })
}

export function githubHttpFailure(response: Response, now: number): TaskFailure {
  if (response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) {
    const retryAfter = Number(response.headers.get('retry-after'))
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    const retry = retryAfter > 0 ? now + retryAfter * 1000 : reset > 0 ? reset * 1000 : now + 60_000
    return { _tag: 'Capacity', message: 'GitHub rate limited this request.', retryAt: new Date(Math.max(now + 1000, retry)).toISOString() }
  }
  return { _tag: response.status >= 500 ? 'Transient' : [401, 403].includes(response.status) ? 'Authorization' : 'Permanent', message: `GitHub returned HTTP ${response.status}.` }
}

export async function readGitHubJson(response: Response, maxBytes = 8 * 1024 * 1024): Promise<Result<unknown>> {
  const reader = response.body?.getReader()
  if (!reader)
    return err({ _tag: 'Permanent', message: 'GitHub returned an empty response.' })
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done)
      break
    size += chunk.value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      return err({ _tag: 'Permanent', message: 'GitHub response exceeds the configured byte limit.' })
    }
    chunks.push(chunk.value)
  }
  return Promise.resolve().then(() => JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown).then(ok).catch(() => err({ _tag: 'Permanent', message: 'GitHub returned invalid JSON.' }))
}

export const githubObject = (value: unknown): Record<string, unknown> | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
export const githubId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export function createGitHubAppAuth(options: { appId: number, privateKey: string, fetch?: typeof globalThis.fetch, now?: () => number, apiUrl?: string }): GitHubAppAuth {
  if (!githubId(options.appId) || options.privateKey.trim() === '')
    throw new Error('GitHub App ID and private key are required.')
  const fetch = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const base = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
  const credentials = new Map<string, GitHubCredential>()
  const inflight = new Map<string, Promise<Result<GitHubCredential>>>()
  let app: GitHubAppIdentity | undefined
  const appRequest = async (path: string, body?: unknown, signal?: AbortSignal): Promise<Result<unknown>> => {
    const epoch = Math.floor(now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const claims = Buffer.from(JSON.stringify({ iat: epoch - 60, exp: epoch + 540, iss: options.appId })).toString('base64url')
    const content = `${header}.${claims}`
    const signature = createSign('RSA-SHA256').update(content).sign(options.privateKey, 'base64url')
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'authorization': `Bearer ${content}.${signature}`, 'accept': 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'octorun', 'x-github-api-version': '2022-11-28' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), redirect: 'error' })
    if (!response.ok) {
      await response.body?.cancel()
      return err(githubHttpFailure(response, now()))
    }
    return readGitHubJson(response)
  }
  const mint = async (repository: string, access: GitHubAccess, signal?: AbortSignal): Promise<Result<GitHubCredential>> => {
    const parsed = parseRepositoryName(repository)
    if (parsed._tag === 'Err')
      return parsed
    const installation = await appRequest(`/repos/${encodeURIComponent(parsed.value.owner)}/${encodeURIComponent(parsed.value.name)}/installation`, undefined, signal)
    if (installation._tag === 'Err')
      return installation
    const installationId = githubObject(installation.value)?.id
    if (!githubId(installationId))
      return err({ _tag: 'Permanent', message: 'GitHub returned an invalid installation identity.' })
    const permissions: Record<string, 'read' | 'write'> = access === 'check' ? { metadata: 'read', checks: 'write' } : access === 'comment' ? { metadata: 'read', issues: 'write', pull_requests: 'write' } : access === 'review' ? { metadata: 'read', pull_requests: 'write' } : { metadata: 'read', contents: 'read', issues: 'read', pull_requests: 'read', checks: 'read' }
    const minted = await appRequest(`/app/installations/${installationId}/access_tokens`, { repositories: [parsed.value.name], permissions }, signal)
    if (minted._tag === 'Err')
      return minted
    const data = githubObject(minted.value)
    const grants = githubObject(data?.permissions)
    const repositories = Array.isArray(data?.repositories) ? data.repositories : []
    if (typeof data?.token !== 'string' || typeof data.expires_at !== 'string' || !Number.isFinite(Date.parse(data.expires_at)) || Date.parse(data.expires_at) <= now() + 60_000 || repositories.length !== 1 || String(githubObject(repositories[0])?.full_name).toLowerCase() !== repository.toLowerCase())
      return err({ _tag: 'Authorization', message: 'GitHub did not grant one valid repository-scoped token.' })
    if (Object.entries(permissions).some(([key, level]) => grants?.[key] !== 'write' && grants?.[key] !== level))
      return err({ _tag: 'Authorization', message: 'GitHub granted fewer permissions than this operation requires.' })
    const credential = { token: data.token, expiresAt: data.expires_at, installationId }
    credentials.set(`${repository.toLowerCase()}:${access}`, credential)
    return ok(credential)
  }
  return {
    appId: options.appId,
    invalidate(repository, access) { credentials.delete(`${repository.toLowerCase()}:${access}`) },
    async identity(signal) {
      if (app)
        return ok(app)
      const result = await appRequest('/app', undefined, signal)
      if (result._tag === 'Err')
        return result
      const value = githubObject(result.value)
      if (value?.id !== options.appId || typeof value.slug !== 'string')
        return err({ _tag: 'Authorization', message: 'GitHub App identity does not match the configured App.' })
      app = { id: options.appId, slug: value.slug }
      return ok(app)
    },
    async token(repository, access, signal) {
      const key = `${repository.toLowerCase()}:${access}`
      const cached = credentials.get(key)
      if (cached && Date.parse(cached.expiresAt) > now() + 60_000)
        return ok(cached)
      const pending = inflight.get(key)
      if (pending)
        return pending
      const work = mint(repository, access, signal).finally(() => inflight.delete(key))
      inflight.set(key, work)
      return work
    },
  }
}
