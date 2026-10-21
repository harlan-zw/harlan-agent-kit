import type { GitHubClient } from './github.ts'
import type { PublicationContext, PublicationEffect, PublicationPublisher, PublicationReceipt, Result } from './types.ts'
import { githubId, githubObject } from './github-auth.ts'
import { githubDigest, githubRepositoryPath } from './github.ts'
import { err, ok } from './types.ts'

export const publicationMarker = (key: string): string => `<!-- octorun:publication:${githubDigest(key)} -->`
export const overviewMarker = (namespace: string): string => `<!-- octorun:overview:${githubDigest(namespace)} -->`
export const findingMarker = (fingerprint: string): string => `<!-- octorun:finding:${githubDigest(fingerprint)} -->`

const bodyWith = (body: string, ...markers: string[]): string => `${body.trim()}\n\n${markers.join('\n')}`
const ownedBy = (value: unknown, actorId: number): boolean => githubObject(githubObject(value)?.user)?.id === actorId
export function isOctorunFinding(value: unknown, actorId: number): boolean {
  const comment = githubObject(value)
  return ownedBy(value, actorId) && !githubId(comment?.in_reply_to_id) && typeof comment?.body === 'string'
    && /\n<!-- octorun:finding:[a-f0-9]{64} -->\n<!-- octorun:publication:[a-f0-9]{64} -->$/.test(comment.body.trimEnd())
}
function hasFinding(value: unknown, actorId: number, fingerprint: string, path: string): boolean {
  const object = githubObject(value)
  return ownedBy(value, actorId) && !githubId(object?.in_reply_to_id) && object?.path === path && typeof object.body === 'string' && object.body.trimEnd().split('\n').at(-2) === findingMarker(fingerprint)
}
function receipt(value: unknown, extra: Record<string, string | number | string[]> = {}): Result<PublicationReceipt> {
  const object = githubObject(value)
  return githubId(object?.id)
    ? ok({ id: String(object.id), url: typeof object.html_url === 'string' ? object.html_url : null, data: { ...extra } })
    : err({ _tag: 'Transient', message: 'GitHub accepted a write without a valid publication identity.' })
}

export function createGitHubPublisher(options: { client: GitHubClient, authorize?: (context: PublicationContext) => Promise<Result<void>> }): PublicationPublisher {
  const client = options.client
  const checkRuns = async (context: PublicationContext): Promise<Result<unknown[]>> => {
    const effect = context.publication.effect
    if (effect._tag !== 'Check')
      return ok([])
    const checks: unknown[] = []
    for (let page = 1; page <= 100; page++) {
      const result = await client.request(effect.repository, 'read', `${githubRepositoryPath(effect.repository)}/commits/${effect.headSha}/check-runs?filter=all&per_page=100&page=${page}`, { signal: context.signal })
      if (result._tag === 'Err')
        return result
      const values = githubObject(result.value)?.check_runs
      if (!Array.isArray(values))
        return err({ _tag: 'Permanent', message: 'GitHub returned an invalid check run listing.' })
      checks.push(...values)
      if (values.length < 100)
        return ok(checks)
    }
    return err({ _tag: 'Capacity', message: 'Check run reconciliation exceeds the page limit.' })
  }
  const readExisting = async (context: PublicationContext): Promise<Result<{ objects: unknown[], botId: number }>> => {
    const effect = context.publication.effect
    const bot = await client.botIdentity(effect.repository, context.signal)
    if (bot._tag === 'Err')
      return bot
    const root = githubRepositoryPath(effect.repository)
    const objects = effect._tag === 'Check'
      ? await checkRuns(context)
      : await client.paginate(effect.repository, effect._tag === 'Review' ? `${root}/pulls/${effect.number}/reviews` : effect._tag === 'Reply' ? `${root}/pulls/${effect.number}/comments` : `${root}/issues/${effect.number}/comments`, context.signal)
    return objects._tag === 'Err' ? objects : ok({ objects: objects.value, botId: bot.value.id })
  }
  const matches = (effect: PublicationEffect, object: unknown, context: PublicationContext, botId: number): boolean => {
    const value = githubObject(object)
    const marker = publicationMarker(context.publication.id)
    if (effect._tag === 'Check') {
      const output = githubObject(value?.output)
      return githubObject(value?.app)?.id === client.auth.appId && value?.external_id === `octorun:${context.run.id}` && value?.name === effect.name && value?.head_sha === effect.headSha && value?.status === effect.phase.status && (effect.phase.status !== 'completed' || value?.conclusion === effect.phase.conclusion) && typeof output?.text === 'string' && output.text.includes(marker)
    }
    return ownedBy(object, botId) && typeof value?.body === 'string' && value.body.trimEnd().endsWith(marker) && (effect._tag !== 'Review' || value.commit_id === effect.headSha)
  }
  const authorize: PublicationPublisher['authorize'] = async (context) => {
    context.signal.throwIfAborted()
    if (options.authorize) {
      const permission = await options.authorize(context)
      if (permission._tag === 'Err')
        return permission
    }
    const effect = context.publication.effect
    if (effect.repository.toLowerCase() !== context.run.event.repository.fullName.toLowerCase())
      return err({ _tag: 'Authorization', message: 'The publication leaves its workflow repository.' })
    const metadata = await client.repository(effect.repository, context.signal)
    if (metadata._tag === 'Err')
      return metadata
    if (metadata.value.ref.id !== context.run.event.repository.id || metadata.value.ref.installationId !== context.run.event.repository.installationId || metadata.value.archived)
      return err({ _tag: 'Authorization', message: 'The installed repository no longer permits this publication.' })
    const target = context.run.event.target
    if (target._tag === 'PullRequest') {
      if (effect._tag !== 'Check' && effect.number !== target.number)
        return err({ _tag: 'Authorization', message: 'The publication leaves its workflow pull request.' })
      const current = await client.snapshot(effect.repository, target.number, context.signal)
      if (current._tag === 'Err')
        return current
      const closesOldCheck = effect._tag === 'Check' && effect.phase.status === 'completed' && ['cancelled', 'skipped'].includes(effect.phase.conclusion)
      if (!closesOldCheck && (current.value.headSha !== target.headSha || current.value.baseSha !== target.baseSha || current.value.state !== 'open'))
        return err({ _tag: 'Authorization', message: 'The pull request changed or closed before publication.' })
      if ((effect._tag === 'Review' || effect._tag === 'Check') && effect.headSha !== target.headSha)
        return err({ _tag: 'Authorization', message: 'The publication head does not match its workflow run.' })
    }
    else if (effect._tag === 'Review' || effect._tag === 'Reply') {
      return err({ _tag: 'Authorization', message: 'This publication requires a pinned pull request.' })
    }
    else if (target._tag === 'Issue' && (effect._tag !== 'Comment' || effect.number !== target.number)) {
      return err({ _tag: 'Authorization', message: 'The publication leaves its workflow issue.' })
    }
    else if (target._tag === 'Revision' && (effect._tag !== 'Check' || effect.headSha !== target.sha)) {
      return err({ _tag: 'Authorization', message: 'The publication leaves its workflow revision.' })
    }
    const body = effect._tag === 'Check' ? effect.summary : effect.body
    if (body.length > 60_000 || (effect._tag === 'Review' && (effect.comments.length > 50 || effect.comments.some(comment => comment.body.length > 10_000 || !Number.isSafeInteger(comment.line) || comment.line < 1 || (comment.startLine !== undefined && (comment.startLine < 1 || comment.startLine > comment.line))))))
      return err({ _tag: 'Permanent', message: 'The publication exceeds GitHub content or location limits.' })
    const token = await client.auth.token(effect.repository, effect._tag === 'Check' ? 'check' : effect._tag === 'Review' || effect._tag === 'Reply' ? 'review' : 'comment', context.signal)
    return token._tag === 'Err' ? token : ok(undefined)
  }
  const reconcile: PublicationPublisher['reconcile'] = async (context) => {
    const existing = await readExisting(context)
    if (existing._tag === 'Err')
      return existing
    const match = existing.value.objects.find(object => matches(context.publication.effect, object, context, existing.value.botId))
    if (!match)
      return ok(null)
    if (context.publication.effect._tag === 'Review') {
      const comments = await client.paginate(context.publication.effect.repository, `${githubRepositoryPath(context.publication.effect.repository)}/pulls/${context.publication.effect.number}/comments`, context.signal)
      if (comments._tag === 'Err')
        return comments
      const missing = context.publication.effect.comments.filter(comment => !comments.value.some(raw => hasFinding(raw, existing.value.botId, comment.fingerprint, comment.path)))
      if (missing.length > 0)
        return ok(null)
    }
    return receipt(match)
  }
  const publish: PublicationPublisher['publish'] = async (context) => {
    const permission = await authorize(context)
    if (permission._tag === 'Err')
      return permission
    const recovered = await reconcile(context)
    if (recovered._tag === 'Err')
      return recovered
    if (recovered.value !== null)
      return ok(recovered.value)
    const effect = context.publication.effect
    const root = githubRepositoryPath(effect.repository)
    const marker = publicationMarker(context.publication.id)
    let path: string
    let method: 'POST' | 'PATCH' = 'POST'
    let body: unknown
    let access: 'comment' | 'review' | 'check'
    if (effect._tag === 'Comment') {
      access = 'comment'
      const existing = await readExisting(context)
      if (existing._tag === 'Err')
        return existing
      const overview = overviewMarker(effect.namespace)
      const previous = existing.value.objects.find(raw => ownedBy(raw, existing.value.botId) && String(githubObject(raw)?.body).trimEnd().split('\n').at(-2) === overview)
      const id = githubObject(previous)?.id
      if (githubId(id)) {
        path = `${root}/issues/comments/${id}`
        method = 'PATCH'
      }
      else {
        path = `${root}/issues/${effect.number}/comments`
      }
      body = { body: bodyWith(effect.body, overview, marker) }
    }
    else if (effect._tag === 'Check') {
      access = 'check'
      const existing = await checkRuns(context)
      if (existing._tag === 'Err')
        return existing
      const previous = existing.value.find(raw => githubObject(githubObject(raw)?.app)?.id === client.auth.appId && githubObject(raw)?.external_id === `octorun:${context.run.id}` && githubObject(raw)?.name === effect.name && githubObject(raw)?.head_sha === effect.headSha)
      const id = githubObject(previous)?.id
      path = githubId(id) ? `${root}/check-runs/${id}` : `${root}/check-runs`
      method = githubId(id) ? 'PATCH' : 'POST'
      const actions = effect.phase.status === 'completed'
        ? [{ label: 'Run again', description: 'Run this workflow again.', identifier: 'rerun' }]
        : [{ label: 'Cancel', description: 'Cancel this workflow run.', identifier: 'cancel' }]
      body = { name: effect.name, head_sha: effect.headSha, external_id: `octorun:${context.run.id}`, ...effect.phase, actions, output: { title: effect.name.slice(0, 255), summary: effect.summary, text: marker }, ...(effect.detailsUrl === undefined ? {} : { details_url: effect.detailsUrl }) }
    }
    else if (effect._tag === 'Reply') {
      access = 'review'
      const original = await client.request(effect.repository, 'read', `${root}/pulls/comments/${effect.commentId}`, { signal: context.signal })
      if (original._tag === 'Err')
        return original
      const comment = githubObject(original.value)
      const rootId = githubId(comment?.in_reply_to_id) ? comment.in_reply_to_id : effect.commentId
      const parent = rootId === effect.commentId ? original : await client.request(effect.repository, 'read', `${root}/pulls/comments/${rootId}`, { signal: context.signal })
      if (parent._tag === 'Err')
        return parent
      const bot = await client.botIdentity(effect.repository, context.signal)
      if (bot._tag === 'Err')
        return bot
      const pullRequestUrl = String(githubObject(parent.value)?.pull_request_url)
      if (!isOctorunFinding(parent.value, bot.value.id) || !pullRequestUrl.endsWith(`${root}/pulls/${effect.number}`))
        return err({ _tag: 'Authorization', message: 'Replies require an App-owned finding in this pull request.' })
      path = `${root}/pulls/${effect.number}/comments/${rootId}/replies`
      body = { body: bodyWith(effect.body, marker) }
    }
    else {
      access = 'review'
      const bot = await client.botIdentity(effect.repository, context.signal)
      if (bot._tag === 'Err')
        return bot
      const existing = await client.paginate(effect.repository, `${root}/pulls/${effect.number}/comments`, context.signal)
      if (existing._tag === 'Err')
        return existing
      const comments = effect.comments.filter(comment => !existing.value.some(raw => hasFinding(raw, bot.value.id, comment.fingerprint, comment.path)))
      path = `${root}/pulls/${effect.number}/reviews`
      body = { commit_id: effect.headSha, event: 'COMMENT', body: bodyWith(effect.body, marker), comments: comments.map(comment => ({ path: comment.path, line: comment.line, side: comment.side, ...(comment.startLine === undefined ? {} : { start_line: comment.startLine, start_side: comment.side }), body: bodyWith(comment.body, findingMarker(comment.fingerprint), marker) })) }
    }
    // Recheck current authority after reconciliation and immediately before the mutation.
    const finalPermission = await authorize(context)
    if (finalPermission._tag === 'Err')
      return finalPermission
    const response = await client.request(effect.repository, access, path, { method, body, signal: context.signal })
    return response._tag === 'Err' ? response : receipt(response.value)
  }
  return { authorize, reconcile, publish }
}
