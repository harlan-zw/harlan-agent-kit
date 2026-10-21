import type { GitHubAccess, GitHubAppAuth } from './github-auth.ts'
import type { RepositoryPermission } from './github-commands.ts'
import type { Actor, EventTarget, RepositoryRef, Result } from './types.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { githubHttpFailure, githubId, githubObject, githubTransportFailure, parseRepositoryName, readGitHubJson } from './github-auth.ts'
import { err, ok } from './types.ts'

export { createGitHubAppAuth } from './github-auth.ts'
export { authorizeGitHubCommand, parseGitHubCommand } from './github-commands.ts'
export { normalizeGitHubWebhook, pollGitHubEvents, verifyWebhookSignature } from './github-events.ts'
export { createGitHubPublisher, findingMarker, overviewMarker, publicationMarker } from './github-publication.ts'

export interface PullRequestSnapshot {
  repository: RepositoryRef
  number: number
  headSha: string
  baseSha: string
  title: string
  body: string
  author: Actor
  draft: boolean
  state: 'open' | 'closed'
  changedFiles: number
  updatedAt: string
  labels: string[]
  headRepository: string | null
}
export interface ChangedFile { path: string, patch: string | null, status: string, truncated: boolean, previousPath?: string, additions: number, deletions: number }
export interface GitHubRepository { ref: RepositoryRef, defaultBranch: string, private: boolean, archived: boolean }
export interface GitHubRequestOptions { method?: 'GET' | 'POST' | 'PATCH', body?: unknown, signal?: AbortSignal | undefined }

export interface GitHubClient {
  auth: GitHubAppAuth
  request: (repository: string, access: GitHubAccess, path: string, options?: GitHubRequestOptions) => Promise<Result<unknown>>
  paginate: (repository: string, path: string, signal?: AbortSignal) => Promise<Result<unknown[]>>
  repository: (repository: string, signal?: AbortSignal) => Promise<Result<GitHubRepository>>
  snapshot: (repository: string, number: number, signal?: AbortSignal) => Promise<Result<PullRequestSnapshot>>
  files: (repository: string, number: number, signal?: AbortSignal) => Promise<Result<ChangedFile[]>>
  permission: (repository: string, actor: Actor, signal?: AbortSignal) => Promise<Result<RepositoryPermission>>
  readFile: (repository: string, path: string, sha: string, signal?: AbortSignal) => Promise<Result<string | null>>
  readWorkflow: (repository: string, path: string, signal?: AbortSignal) => Promise<Result<{ sha: string, text: string | null }>>
  botIdentity: (repository: string, signal?: AbortSignal) => Promise<Result<Actor>>
}

export function parseGitHubActor(input: unknown): Result<Actor> {
  const actor = githubObject(input)
  return actor && githubId(actor.id) && typeof actor.login === 'string' && ['User', 'Bot'].includes(String(actor.type))
    ? ok({ id: actor.id, login: actor.login, kind: actor.type as Actor['kind'] })
    : err({ _tag: 'Permanent', message: 'GitHub returned an invalid actor identity.' })
}

export function parseGitHubPullRequest(input: unknown, repository: RepositoryRef): Result<PullRequestSnapshot> {
  const value = githubObject(input)
  const head = githubObject(value?.head)
  const base = githubObject(value?.base)
  const actor = parseGitHubActor(value?.user)
  const baseRepo = githubObject(base?.repo)
  if (!value || !githubId(value.number) || typeof head?.sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(head.sha) || typeof base?.sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(base.sha) || typeof value.title !== 'string' || !['open', 'closed'].includes(String(value.state)) || actor._tag === 'Err' || baseRepo?.id !== repository.id || String(baseRepo.full_name).toLowerCase() !== repository.fullName.toLowerCase() || typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at)))
    return err({ _tag: 'Permanent', message: 'GitHub returned an invalid pull request snapshot.' })
  return ok({ repository, number: value.number, headSha: head.sha, baseSha: base.sha, title: value.title, body: typeof value.body === 'string' ? value.body : '', author: actor.value, draft: value.draft === true, state: value.state as 'open' | 'closed', changedFiles: typeof value.changed_files === 'number' ? value.changed_files : 0, updatedAt: value.updated_at, labels: Array.isArray(value.labels) ? value.labels.flatMap(label => typeof githubObject(label)?.name === 'string' ? [githubObject(label)!.name as string] : []) : [], headRepository: typeof githubObject(head.repo)?.full_name === 'string' ? githubObject(head.repo)!.full_name as string : null })
}

export const githubRepositoryPath = (repository: string): string => `/repos/${repository.split('/').map(encodeURIComponent).join('/')}`
export const githubDigest = (value: string): string => createHash('sha256').update(value).digest('hex')

export function createGitHubClient(options: { auth: GitHubAppAuth, fetch?: typeof globalThis.fetch, now?: () => number, apiUrl?: string, maxPages?: number }): GitHubClient {
  const fetch = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const base = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
  let bot: Actor | undefined
  const request: GitHubClient['request'] = async (repository, access, path, requestOptions = {}) => {
    if (requestOptions.signal?.aborted)
      return err(githubTransportFailure(requestOptions.signal))
    const parsed = parseRepositoryName(repository)
    if (parsed._tag === 'Err')
      return parsed
    const expected = `${githubRepositoryPath(repository)}/`
    if (path !== expected.slice(0, -1) && !path.startsWith(expected) && !/^\/users\/[^/?]+$/.test(path))
      return err({ _tag: 'Authorization', message: 'The GitHub route leaves the configured repository.' })
    if (path.includes('..') || path.includes('\\') || path.includes('#'))
      return err({ _tag: 'Configuration', message: 'The GitHub route contains an invalid path.' })
    for (let attempt = 0; attempt < 2; attempt++) {
      const credential = await options.auth.token(repository, access, requestOptions.signal)
      if (credential._tag === 'Err')
        return credential
      const response = await Promise.resolve().then(() => fetch(`${base}${path}`, { method: requestOptions.method ?? 'GET', headers: { 'authorization': `Bearer ${credential.value.token}`, 'accept': 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'octorun', 'x-github-api-version': '2022-11-28' }, ...(requestOptions.body === undefined ? {} : { body: JSON.stringify(requestOptions.body) }), signal: requestOptions.signal ? AbortSignal.any([requestOptions.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), redirect: 'error' })).then(ok).catch(() => err(githubTransportFailure(requestOptions.signal)))
      if (response._tag === 'Err')
        return response
      if (!response.value.ok) {
        const failure = githubHttpFailure(response.value, now())
        await response.value.body?.cancel().catch(() => {
          // This rejected response already has an HTTP outcome. Discard failures cannot replace it.
        })
        if (response.value.status === 401 && attempt === 0) {
          options.auth.invalidate(repository, access)
          continue
        }
        return err(failure)
      }
      return response.value.status === 204 ? ok(null) : readGitHubJson(response.value, undefined, requestOptions.signal)
    }
    return err({ _tag: 'Authorization', message: 'GitHub rejected the refreshed App credential.' })
  }
  const paginate: GitHubClient['paginate'] = async (repository, path, signal) => {
    const values: unknown[] = []
    const maxPages = options.maxPages ?? 100
    for (let page = 1; page <= maxPages; page++) {
      const result = await request(repository, 'read', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { signal })
      if (result._tag === 'Err')
        return result
      if (!Array.isArray(result.value))
        return err({ _tag: 'Permanent', message: 'GitHub returned an invalid paginated response.' })
      values.push(...result.value)
      if (result.value.length < 100)
        return ok(values)
    }
    return err({ _tag: 'Capacity', message: 'GitHub pagination exceeds the configured page limit.' })
  }
  const repository: GitHubClient['repository'] = async (name, signal) => {
    const data = await request(name, 'read', githubRepositoryPath(name), { signal })
    if (data._tag === 'Err')
      return data
    const value = githubObject(data.value)
    const token = await options.auth.token(name, 'read', signal)
    if (token._tag === 'Err')
      return token
    if (!value || !githubId(value.id) || typeof value.full_name !== 'string' || value.full_name.toLowerCase() !== name.toLowerCase() || typeof value.default_branch !== 'string')
      return err({ _tag: 'Authorization', message: 'GitHub repository identity does not match the configured repository.' })
    return ok({ ref: { id: value.id, fullName: value.full_name, installationId: token.value.installationId }, defaultBranch: value.default_branch, private: value.private === true, archived: value.archived === true })
  }
  const snapshot: GitHubClient['snapshot'] = async (name, number, signal) => {
    if (!githubId(number))
      return err({ _tag: 'Configuration', message: 'A positive pull request number is required.' })
    const metadata = await repository(name, signal)
    if (metadata._tag === 'Err')
      return metadata
    const data = await request(name, 'read', `${githubRepositoryPath(name)}/pulls/${number}`, { signal })
    return data._tag === 'Err' ? data : parseGitHubPullRequest(data.value, metadata.value.ref)
  }
  const files: GitHubClient['files'] = async (name, number, signal) => {
    const data = await paginate(name, `${githubRepositoryPath(name)}/pulls/${number}/files`, signal)
    if (data._tag === 'Err')
      return data
    if (data.value.length >= 3000)
      return err({ _tag: 'Capacity', message: 'GitHub file listing may exceed its 3000-file limit.' })
    const parsed: ChangedFile[] = []
    for (const raw of data.value) {
      const file = githubObject(raw)
      if (typeof file?.filename !== 'string' || typeof file.status !== 'string' || typeof file.additions !== 'number' || typeof file.deletions !== 'number')
        return err({ _tag: 'Permanent', message: 'GitHub returned an invalid changed file.' })
      const patch = typeof file.patch === 'string' ? file.patch : null
      let additions = 0
      let deletions = 0
      for (const line of patch?.split('\n') ?? []) {
        if (line.startsWith('+'))
          additions++
        if (line.startsWith('-'))
          deletions++
      }
      parsed.push({ path: file.filename, patch, status: file.status, truncated: patch === null || additions < file.additions || deletions < file.deletions, additions: file.additions, deletions: file.deletions, ...(typeof file.previous_filename === 'string' ? { previousPath: file.previous_filename } : {}) })
    }
    return ok(parsed)
  }
  const readFile: GitHubClient['readFile'] = async (name, path, sha, signal) => {
    if (!/^[a-f0-9]{40,64}$/i.test(sha) || path.split('/').some(part => part === '..' || part === '.'))
      return err({ _tag: 'Configuration', message: 'A pinned commit and a repository file path are required.' })
    const data = await request(name, 'read', `${githubRepositoryPath(name)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`, { signal })
    if (data._tag === 'Err')
      return data.error.message === 'GitHub returned HTTP 404.' ? ok(null) : data
    const value = githubObject(data.value)
    if (value?.encoding !== 'base64' || typeof value.content !== 'string' || typeof value.size !== 'number' || value.size > 512 * 1024)
      return err({ _tag: 'Permanent', message: 'GitHub configuration file is missing, invalid, or too large.' })
    return ok(Buffer.from(value.content, 'base64').toString('utf8'))
  }
  return {
    auth: options.auth,
    request,
    paginate,
    repository,
    snapshot,
    files,
    readFile,
    async permission(name, actor, signal) {
      const data = await request(name, 'read', `${githubRepositoryPath(name)}/collaborators/${encodeURIComponent(actor.login)}/permission`, { signal })
      if (data._tag === 'Err')
        return data.error.message === 'GitHub returned HTTP 404.' ? ok('none') : data
      const value = githubObject(data.value)
      if (githubObject(value?.user)?.id !== actor.id)
        return err({ _tag: 'Authorization', message: 'The GitHub permission response identifies a different user.' })
      const permission = value?.permission
      return ['none', 'read', 'triage', 'write', 'maintain', 'admin'].includes(String(permission))
        ? ok(permission as RepositoryPermission)
        : err({ _tag: 'Authorization', message: 'GitHub returned an unknown repository permission.' })
    },
    async readWorkflow(name, path, signal) {
      const metadata = await repository(name, signal)
      if (metadata._tag === 'Err')
        return metadata
      const commit = await request(name, 'read', `${githubRepositoryPath(name)}/commits/${encodeURIComponent(metadata.value.defaultBranch)}`, { signal })
      if (commit._tag === 'Err')
        return commit
      const sha = githubObject(commit.value)?.sha
      if (typeof sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(sha))
        return err({ _tag: 'Permanent', message: 'GitHub returned an invalid trusted branch commit.' })
      const text = await readFile(name, path, sha, signal)
      return text._tag === 'Err' ? text : ok({ sha, text: text.value })
    },
    async botIdentity(name, signal) {
      if (bot)
        return ok(bot)
      const identity = await options.auth.identity(signal)
      if (identity._tag === 'Err')
        return identity
      const user = await request(name, 'read', `/users/${encodeURIComponent(`${identity.value.slug}[bot]`)}`, { signal })
      if (user._tag === 'Err')
        return user
      const parsed = parseGitHubActor(user.value)
      if (parsed._tag === 'Err' || parsed.value.kind !== 'Bot' || parsed.value.login.toLowerCase() !== `${identity.value.slug}[bot]`.toLowerCase())
        return err({ _tag: 'Authorization', message: 'GitHub returned an invalid App bot identity.' })
      bot = parsed.value
      return ok(bot)
    },
  }
}

/** Read APIs carry no repository execution or write capability. */
export function createGitHubSnapshotReader(client: GitHubClient) {
  return {
    async read(repository: string, target: Extract<EventTarget, { _tag: 'PullRequest' }>, signal: AbortSignal) {
      const before = await client.snapshot(repository, target.number, signal)
      if (before._tag === 'Err')
        return before
      if (before.value.headSha !== target.headSha || before.value.baseSha !== target.baseSha)
        return err({ _tag: 'Permanent', message: 'The pull request changed before snapshot acquisition.' })
      const files = await client.files(repository, target.number, signal)
      if (files._tag === 'Err')
        return files
      if (before.value.changedFiles > files.value.length)
        return err({ _tag: 'Permanent', message: 'GitHub returned an incomplete file listing.' })
      const after = await client.snapshot(repository, target.number, signal)
      if (after._tag === 'Err')
        return after
      if (after.value.headSha !== target.headSha || after.value.baseSha !== target.baseSha)
        return err({ _tag: 'Permanent', message: 'The pull request changed during snapshot acquisition.' })
      return ok({ headSha: target.headSha, baseSha: target.baseSha, title: before.value.title, body: before.value.body, files: files.value })
    },
  }
}
