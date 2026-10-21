import type { GitHubClient, PullRequestSnapshot } from './github.ts'
import type { Actor, EventEnvelope, EventTarget, JsonValue, RepositoryRef, Result } from './types.ts'
import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { githubId, githubObject } from './github-auth.ts'
import { githubDigest, githubRepositoryPath, parseGitHubActor } from './github.ts'
import { err, isJsonValue, ok } from './types.ts'

export function verifyWebhookSignature(secret: string, body: string | Uint8Array, signature: string | null): boolean {
  if (secret.length === 0 || !signature || !/^sha256=[a-f0-9]{64}$/i.test(signature))
    return false
  const expected = createHmac('sha256', secret).update(body).digest()
  const actual = Buffer.from(signature.slice(7), 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

const pullTarget = (snapshot: PullRequestSnapshot): EventTarget => ({ _tag: 'PullRequest', number: snapshot.number, headSha: snapshot.headSha, baseSha: snapshot.baseSha })
const date = (input: unknown, fallback: string): string => typeof input === 'string' && Number.isFinite(Date.parse(input)) ? new Date(input).toISOString() : fallback
function optionalActor(input: unknown): Actor | null {
  const parsed = parseGitHubActor(input)
  return parsed._tag === 'Ok' ? parsed.value : null
}

/** Polling and deliveries share semantic keys for observed pull request revisions. */
export function pullRequestSemanticKey(repository: RepositoryRef, target: Extract<EventTarget, { _tag: 'PullRequest' }>, state: { draft: boolean, state: string }): string {
  return `pull-request:${repository.id}:${target.number}:${target.headSha}:${target.baseSha}:${state.state}:${state.draft ? 'draft' : 'ready'}`
}

export interface NormalizeWebhookOptions {
  event: string
  delivery: string
  payload: unknown
  client: GitHubClient
  handle?: string
  now?: () => number
  signal?: AbortSignal
  resolveCheckTarget?: (externalId: string, headSha: string) => Promise<Extract<EventTarget, { _tag: 'PullRequest' }> | null>
}

/** Call only after signature verification. Ingress persists returned events before acknowledging GitHub. */
export async function normalizeGitHubWebhook(options: NormalizeWebhookOptions): Promise<Result<EventEnvelope[]>> {
  if (!/^[\w-]{1,128}$/.test(options.delivery))
    return err({ _tag: 'Configuration', message: 'GitHub delivery identity is invalid.' })
  const payload = githubObject(options.payload)
  const repo = githubObject(payload?.repository)
  const installation = githubObject(payload?.installation)
  if (options.event === 'ping')
    return ok([])
  if (!['pull_request', 'issue_comment', 'pull_request_review_comment', 'check_run', 'push'].includes(options.event))
    return ok([])
  if (!payload || !githubId(repo?.id) || typeof repo.full_name !== 'string' || !githubId(installation?.id))
    return err({ _tag: 'Permanent', message: 'GitHub delivery repository or installation identity is invalid.' })
  const repository: RepositoryRef = { id: repo.id, fullName: repo.full_name, installationId: installation.id }
  const receivedAt = new Date((options.now ?? Date.now)()).toISOString()
  const actor = optionalActor(payload.sender)
  const action = typeof payload.action === 'string' ? payload.action : 'updated'
  const base = { id: `webhook:${options.delivery}`, source: 'webhook' as const, repository, actor, receivedAt }
  let target: EventTarget
  let semanticKey = `webhook:${options.delivery}`
  let occurredAt = receivedAt
  let data: JsonValue = null
  let name = options.event
  if (options.event === 'pull_request') {
    const pr = githubObject(payload.pull_request)
    if (!githubId(pr?.number) || !['opened', 'reopened', 'synchronize', 'ready_for_review', 'converted_to_draft', 'closed', 'labeled', 'unlabeled', 'edited'].includes(action))
      return ok([])
    const snapshot = await options.client.snapshot(repository.fullName, pr.number, options.signal)
    if (snapshot._tag === 'Err')
      return snapshot
    if (snapshot.value.repository.id !== repository.id || snapshot.value.repository.installationId !== repository.installationId)
      return err({ _tag: 'Authorization', message: 'GitHub delivery no longer matches the installed repository.' })
    // A delayed delivery cannot bind its old head to the latest snapshot.
    const deliveredHead = githubObject(pr.head)?.sha
    const deliveredBase = githubObject(pr.base)?.sha
    if (deliveredHead !== snapshot.value.headSha || deliveredBase !== snapshot.value.baseSha)
      return ok([])
    target = pullTarget(snapshot.value)
    semanticKey = ['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(action)
      ? pullRequestSemanticKey(repository, target as Extract<EventTarget, { _tag: 'PullRequest' }>, snapshot.value)
      : `webhook:${options.delivery}`
    occurredAt = date(pr.updated_at, receivedAt)
    data = { draft: snapshot.value.draft, state: snapshot.value.state, labels: snapshot.value.labels, title: snapshot.value.title, author: snapshot.value.author.login }
  }
  else if (options.event === 'issue_comment' || options.event === 'pull_request_review_comment') {
    if (!['created', 'edited'].includes(action))
      return ok([])
    const comment = githubObject(payload.comment)
    const object = githubObject(options.event === 'issue_comment' ? payload.issue : payload.pull_request)
    if (!comment || !githubId(comment.id) || typeof comment.body !== 'string' || !githubId(object?.number))
      return err({ _tag: 'Permanent', message: 'GitHub delivery contains an invalid comment.' })
    const author = optionalActor(comment.user)
    const bot = await options.client.botIdentity(repository.fullName, options.signal)
    if (bot._tag === 'Err')
      return bot
    if (author?.id === bot.value.id || author?.kind === 'Bot' || actor?.kind === 'Bot')
      return ok([])
    const isPullRequest = options.event === 'pull_request_review_comment' || githubObject(object.pull_request) !== null
    if (isPullRequest) {
      const snapshot = await options.client.snapshot(repository.fullName, object.number, options.signal)
      if (snapshot._tag === 'Err')
        return snapshot
      if (snapshot.value.repository.id !== repository.id || snapshot.value.repository.installationId !== repository.installationId)
        return err({ _tag: 'Authorization', message: 'GitHub comment no longer matches the installed repository.' })
      target = pullTarget(snapshot.value)
    }
    else {
      target = { _tag: 'Issue', number: object.number }
    }
    occurredAt = date(comment.updated_at, receivedAt)
    const revision = githubDigest(`${occurredAt}:${comment.body}`)
    semanticKey = `comment:${repository.id}:${options.event}:${comment.id}:${revision}`
    data = { commentId: comment.id, body: comment.body, authorId: author?.id ?? null, inReplyToId: githubId(comment.in_reply_to_id) ? comment.in_reply_to_id : null, url: typeof comment.html_url === 'string' ? comment.html_url : null, revision }
  }
  else if (options.event === 'check_run') {
    if (!['rerequested', 'requested_action'].includes(action))
      return ok([])
    const check = githubObject(payload.check_run)
    const requestedAction = githubObject(payload.requested_action)?.identifier
    if (action === 'requested_action' && !['cancel', 'rerun'].includes(String(requestedAction)))
      return ok([])
    if (!githubId(check?.id) || githubObject(check?.app)?.id !== options.client.auth.appId || typeof check?.external_id !== 'string' || !check.external_id.startsWith('octorun:') || typeof check.head_sha !== 'string')
      return ok([])
    const recorded = await options.resolveCheckTarget?.(check.external_id, check.head_sha)
    if (!recorded || recorded.headSha !== check.head_sha)
      return err({ _tag: 'Authorization', message: 'The check run does not identify a recorded Octorun run.' })
    const snapshot = await options.client.snapshot(repository.fullName, recorded.number, options.signal)
    if (snapshot._tag === 'Err')
      return snapshot
    if (snapshot.value.headSha !== recorded.headSha || snapshot.value.repository.id !== repository.id || snapshot.value.repository.installationId !== repository.installationId)
      return ok([])
    target = pullTarget(snapshot.value)
    data = { checkId: check.id, externalId: check.external_id, command: action === 'rerequested' ? 'rerun' : requestedAction as string }
  }
  else if (options.event === 'push') {
    if (typeof payload.after !== 'string' || !/^[a-f0-9]{40,64}$/i.test(payload.after) || typeof payload.ref !== 'string' || /^0+$/.test(payload.after))
      return ok([])
    target = { _tag: 'Revision', sha: payload.after, ref: payload.ref }
    name = 'push'
    data = { deleted: payload.deleted === true, forced: payload.forced === true }
  }
  else {
    return ok([])
  }
  if (!isJsonValue(data))
    return err({ _tag: 'Permanent', message: 'GitHub event exceeds the accepted JSON limits.' })
  return ok([{ ...base, name, action, target, semanticKey, occurredAt, data }])
}

export interface GitHubPollCursor {
  version: 1
  since: string
  pullRequests: Record<string, string>
  comments: Record<string, string>
}

/** Observation cannot recover deleted comments, label actors, native reruns, or historical deliveries. */
export async function pollGitHubEvents(options: { client: GitHubClient, repository: string, cursor?: GitHubPollCursor, includeExisting?: boolean, now?: () => number, signal?: AbortSignal }): Promise<Result<{ events: EventEnvelope[], cursor: GitHubPollCursor }>> {
  const receivedAt = new Date((options.now ?? Date.now)()).toISOString()
  const repository = await options.client.repository(options.repository, options.signal)
  if (repository._tag === 'Err')
    return repository
  const previous = options.cursor
  if (previous && (previous.version !== 1 || !Number.isFinite(Date.parse(previous.since))))
    return err({ _tag: 'Configuration', message: 'The GitHub poll cursor is invalid.' })
  const cursor: GitHubPollCursor = { version: 1, since: receivedAt, pullRequests: {}, comments: { ...previous?.comments } }
  const events: EventEnvelope[] = []
  const observedCommentKeys = new Set<string>()
  const prs = await options.client.paginate(options.repository, `${githubRepositoryPath(options.repository)}/pulls?state=open&sort=updated&direction=desc`, options.signal)
  if (prs._tag === 'Err')
    return prs
  const snapshots = new Map<number, PullRequestSnapshot>()
  for (const raw of prs.value) {
    const number = githubObject(raw)?.number
    if (!githubId(number))
      return err({ _tag: 'Permanent', message: 'GitHub returned an invalid pull request observation.' })
    const snapshot = await options.client.snapshot(options.repository, number, options.signal)
    if (snapshot._tag === 'Err')
      return snapshot
    snapshots.set(number, snapshot.value)
    const target = pullTarget(snapshot.value) as Extract<EventTarget, { _tag: 'PullRequest' }>
    const semanticKey = pullRequestSemanticKey(repository.value.ref, target, snapshot.value)
    cursor.pullRequests[String(number)] = semanticKey
    if ((!previous && options.includeExisting !== true) || previous?.pullRequests[String(number)] === semanticKey)
      continue
    const observation = { repository: repository.value.ref, target, semanticKey, occurredAt: snapshot.value.updatedAt, data: { draft: snapshot.value.draft, state: snapshot.value.state, labels: snapshot.value.labels, title: snapshot.value.title, author: snapshot.value.author.login } }
    events.push({ id: `poll:${githubDigest(JSON.stringify(observation))}`, source: 'poll', name: 'pull_request', action: 'observed', actor: null, receivedAt, ...observation })
  }
  // Overlap one second so comments with equal timestamps are not lost between passes.
  const since = new Date(Date.parse(previous?.since ?? receivedAt) - 1000).toISOString()
  const bot = await options.client.botIdentity(options.repository, options.signal)
  if (bot._tag === 'Err')
    return bot
  for (const kind of ['issue_comment', 'pull_request_review_comment'] as const) {
    const path = kind === 'issue_comment' ? 'issues/comments' : 'pulls/comments'
    const comments = await options.client.paginate(options.repository, `${githubRepositoryPath(options.repository)}/${path}?since=${encodeURIComponent(since)}&sort=updated&direction=asc`, options.signal)
    if (comments._tag === 'Err')
      return comments
    for (const raw of comments.value) {
      const comment = githubObject(raw)
      const author = optionalActor(comment?.user)
      if (!comment || !githubId(comment.id) || typeof comment.body !== 'string' || typeof comment.created_at !== 'string' || typeof comment.updated_at !== 'string')
        return err({ _tag: 'Permanent', message: 'GitHub returned an invalid comment observation.' })
      if (!author || author.id === bot.value.id || author.kind === 'Bot')
        continue
      const revision = githubDigest(`${date(comment.updated_at, receivedAt)}:${comment.body}`)
      const key = `${kind}:${comment.id}`
      observedCommentKeys.add(key)
      const alreadySeen = previous?.comments[key] === revision
      cursor.comments[key] = revision
      // Polling cannot identify an editor. Only original, unedited comments carry actor authority.
      if (alreadySeen || comment.created_at !== comment.updated_at || Date.parse(comment.created_at) < Date.parse(previous?.since ?? receivedAt) - 1000)
        continue
      const url = kind === 'issue_comment' ? comment.issue_url : comment.pull_request_url
      const match = typeof url === 'string' ? /\/(?:issues|pulls)\/(\d+)$/.exec(url) : null
      if (!match)
        return err({ _tag: 'Permanent', message: 'GitHub comment does not identify its parent.' })
      const number = Number(match[1])
      const snapshot = snapshots.get(number)
      // Closed PR and Issue comments are informational Issue targets unless a webhook resolves them.
      const target: EventTarget = snapshot ? pullTarget(snapshot) : { _tag: 'Issue', number }
      const semanticKey = `comment:${repository.value.ref.id}:${kind}:${comment.id}:${revision}`
      events.push({ id: `poll:${semanticKey}`, source: 'poll', name: kind, action: 'created', repository: repository.value.ref, actor: author, target, semanticKey, occurredAt: date(comment.updated_at, receivedAt), receivedAt, data: { commentId: comment.id, body: comment.body, authorId: author.id, inReplyToId: githubId(comment.in_reply_to_id) ? comment.in_reply_to_id : null, url: typeof comment.html_url === 'string' ? comment.html_url : null, revision } })
    }
  }
  // Retain only revisions returned by the overlap window. Older comments cannot reappear in later pages.
  for (const key of Object.keys(cursor.comments)) {
    if (!observedCommentKeys.has(key))
      delete cursor.comments[key]
  }
  return ok({ events, cursor })
}
