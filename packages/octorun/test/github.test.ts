import type { GitHubAppAuth } from '../src/github-auth.ts'
import type { PublicationContext, PublicationEffect, Result } from '../src/types.ts'
import { Buffer } from 'node:buffer'
import { createHmac, generateKeyPairSync, verify } from 'node:crypto'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGitHubAppAuth, createGitHubClient, createGitHubPublisher, createGitHubSnapshotReader, findingMarker, normalizeGitHubWebhook, overviewMarker, pollGitHubEvents, publicationMarker, verifyWebhookSignature } from '../src/github.ts'

const now = Date.parse('2026-10-21T00:00:00.000Z')
const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const repository = { id: 10, fullName: 'acme/project', installationId: 20 }
const bot = { id: 90, login: 'octorun[bot]', type: 'Bot' }
const user = { id: 30, login: 'alice', type: 'User' }
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const closeFixtures: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(closeFixtures.splice(0).map(close => close()))
  vi.restoreAllMocks()
})

function transportCaller(surface: 'repository' | 'app', fetch: typeof globalThis.fetch): (signal?: AbortSignal) => Promise<Result<unknown>> {
  const auth: GitHubAppAuth = { appId: 7, token: async () => ({ _tag: 'Ok', value: { token: 'fixture', installationId: 20, expiresAt: new Date(now + 3600000).toISOString() } }), identity: async () => ({ _tag: 'Ok', value: { id: 7, slug: 'octorun' } }), invalidate: () => {} }
  if (surface === 'app')
    return createGitHubAppAuth({ appId: 7, privateKey, fetch, now: () => now }).identity
  const client = createGitHubClient({ auth, fetch, now: () => now })
  return signal => client.repository('acme/project', signal)
}

interface FixtureRequest { method: string, path: string, body: Record<string, unknown>, authorization: string }

async function fixture(custom?: (request: FixtureRequest) => { status?: number, body: unknown, headers?: Record<string, string>, disconnect?: boolean } | undefined) {
  const requests: FixtureRequest[] = []
  const comments: Record<string, unknown>[] = []
  const reviews: Record<string, unknown>[] = []
  const findings: Record<string, unknown>[] = []
  const checks: Record<string, unknown>[] = []
  let currentHead = head
  let nextId = 100
  const pr = () => ({ number: 1, head: { sha: currentHead, repo: { full_name: 'outside/fork' } }, base: { sha: base, repo: { id: 10, full_name: 'acme/project' } }, title: 'Example change', body: '', user, draft: false, state: 'open', updated_at: new Date(now).toISOString(), changed_files: 1, labels: [] })
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req)
      chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString()
    const request: FixtureRequest = { method: req.method ?? 'GET', path: req.url ?? '/', body: text ? JSON.parse(text) : {}, authorization: req.headers.authorization ?? '' }
    requests.push(request)
    const path = request.path.split('?')[0]!
    let response = custom?.(request)
    if (!response) {
      if (path === '/app') {
        response = { body: { id: 7, slug: 'octorun' } }
      }
      else if (path === '/repos/acme/project/installation') {
        response = { body: { id: 20 } }
      }
      else if (path === '/app/installations/20/access_tokens') {
        response = { body: { token: `installation-token-${nextId++}`, expires_at: new Date(now + 3600_000).toISOString(), permissions: request.body.permissions, repositories: [{ id: 10, full_name: 'acme/project' }] } }
      }
      else if (path === '/repos/acme/project' || path === '/repos/acme/project/') {
        response = { body: { id: 10, full_name: 'acme/project', default_branch: 'main', private: false, archived: false } }
      }
      else if (path === '/users/octorun%5Bbot%5D') {
        response = { body: bot }
      }
      else if (path === '/repos/acme/project/pulls/1') {
        response = { body: pr() }
      }
      else if (path === '/repos/acme/project/pulls') {
        response = { body: [pr()] }
      }
      else if (path === '/repos/acme/project/pulls/1/files') {
        response = { body: [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }] }
      }
      else if (path === '/repos/acme/project/issues/1/comments' && request.method === 'POST') {
        const comment = { id: nextId++, body: request.body.body, user: bot, html_url: 'https://github.com/acme/project/pull/1#issuecomment-1' }
        comments.push(comment)
        response = { body: comment }
      }
      else if (path.startsWith('/repos/acme/project/issues/comments/') && request.method === 'PATCH') {
        const comment = comments.find(value => value.id === Number(path.split('/').at(-1)))!
        Object.assign(comment, request.body)
        response = { body: comment }
      }
      else if (path === '/repos/acme/project/issues/1/comments') {
        response = { body: comments }
      }
      else if (path === '/repos/acme/project/pulls/1/reviews' && request.method === 'POST') {
        const review = { id: nextId++, body: request.body.body, commit_id: request.body.commit_id, user: bot }
        reviews.push(review)
        for (const raw of request.body.comments as Record<string, unknown>[])
          findings.push({ ...raw, id: nextId++, user: bot, pull_request_url: 'https://api.github.com/repos/acme/project/pulls/1' })
        response = { body: review }
      }
      else if (path === '/repos/acme/project/pulls/1/reviews') {
        response = { body: reviews }
      }
      else if (path === '/repos/acme/project/pulls/1/comments') {
        response = { body: findings }
      }
      else if (path === '/repos/acme/project/issues/comments' || path === '/repos/acme/project/pulls/comments') {
        response = { body: [] }
      }
      else if (path.endsWith('/check-runs') && request.method === 'GET') {
        response = { body: { check_runs: checks } }
      }
      else if (path === '/repos/acme/project/check-runs' && request.method === 'POST') {
        const check = { ...request.body, id: nextId++, app: { id: 7 } }
        checks.push(check)
        response = { body: check }
      }
      else if (path.startsWith('/repos/acme/project/check-runs/') && request.method === 'PATCH') {
        const check = checks.find(value => value.id === Number(path.split('/').at(-1)))!
        Object.assign(check, request.body)
        response = { body: check }
      }
      else {
        response = { status: 404, body: { message: 'Not found' } }
      }
    }
    if (response.disconnect) {
      res.destroy()
      return
    }
    res.writeHead(response.status ?? 200, { 'content-type': 'application/json', ...response.headers })
    res.end(JSON.stringify(response.body))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closeFixtures.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('Expected a TCP fixture address.')
  const apiUrl = `http://127.0.0.1:${address.port}`
  const auth = createGitHubAppAuth({ appId: 7, privateKey, apiUrl, now: () => now })
  const client = createGitHubClient({ auth, apiUrl, now: () => now })
  return { client, auth, requests, comments, reviews, findings, checks, pr, moveHead: (sha: string) => {
    currentHead = sha
  } }
}

function publication(effect: PublicationEffect, key = 'result', runId = 'run-1'): PublicationContext {
  return {
    signal: new AbortController().signal,
    publication: { id: key, key, runId, taskId: 'publish', effect, state: { _tag: 'Queued' }, attempts: 0, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() },
    run: { id: runId, event: { id: 'event-1', source: 'manual', name: 'pull_request', action: 'opened', repository, actor: null, target: { _tag: 'PullRequest', number: 1, headSha: head, baseSha: base }, occurredAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), semanticKey: 'head', data: null }, definition: { version: 1, id: 'review', name: 'Review', on: [], tasks: [], concurrency: { mode: 'replace', group: 'target' }, limits: { maxAttempts: 1, timeoutMs: 1000, maxTokens: 1000, maxCostUsd: 1, maxDurationMs: 1000 } }, definitionDigest: 'digest', configuration: { source: 'test', sha: base, digest: 'digest' }, policy: { enabled: true, capabilities: ['repository:read', 'github:review', 'github:comment', 'github:check'], maxConcurrency: 1 }, state: { _tag: 'Running' }, tasks: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: null }, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), startedAt: null, finishedAt: null },
  }
}

describe('gitHub App authentication', () => {
  it.each(['repository', 'app'] as const)('returns a transient %s transport failure and recovers on retry', async (surface) => {
    let calls = 0
    const invoke = transportCaller(surface, async () => {
      if (calls++ === 0)
        throw new TypeError('Synthetic connection reset.')
      return Response.json(surface === 'app' ? { id: 7, slug: 'octorun' } : { id: 10, full_name: 'acme/project', default_branch: 'main' })
    })
    expect(await invoke()).toMatchObject({ _tag: 'Err', error: { _tag: 'Transient' } })
    expect(await invoke()).toMatchObject({ _tag: 'Ok' })
    expect(calls).toBe(2)
  })

  it.each(['repository', 'app'] as const)('returns a transient %s response stream failure', async (surface) => {
    const invoke = transportCaller(surface, async () => new Response(new ReadableStream({
      start(controller) {
        controller.error(new TypeError('Synthetic response reset.'))
      },
    })))
    expect(await invoke()).toMatchObject({ _tag: 'Err', error: { _tag: 'Transient' } })
  })

  it.each(['repository', 'app'] as const)('keeps an internal %s timeout retryable', async (surface) => {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort(new DOMException('Synthetic timeout.', 'TimeoutError')))
    let calls = 0
    const invoke = transportCaller(surface, async (_input, init) => {
      calls++
      init?.signal?.throwIfAborted()
      return Response.json({})
    })
    expect(await invoke()).toMatchObject({ _tag: 'Err', error: { _tag: 'Transient' } })
    expect(calls).toBe(1)
  })

  it.each(['repository', 'app'] as const)('keeps caller cancellation separate from %s transport failure', async (surface) => {
    let calls = 0
    const invoke = transportCaller(surface, async () => {
      calls++
      throw new TypeError('The cancelled request reached fetch.')
    })
    expect(await invoke(AbortSignal.abort())).toMatchObject({ _tag: 'Err', error: { _tag: 'Permanent', message: 'The GitHub request was cancelled.' } })
    expect(calls).toBe(0)
  })

  it('keeps invalid App signing keys distinct from transport failures', async () => {
    let calls = 0
    const auth = createGitHubAppAuth({ appId: 7, privateKey: 'invalid signing key', fetch: async () => {
      calls++
      throw new TypeError('Signing must happen before transport.')
    } })
    await expect(auth.identity()).rejects.toThrow()
    expect(calls).toBe(0)
  })

  it('signs JWTs, mints only one repository, and scopes credentials per operation', async () => {
    const test = await fixture()
    expect(await test.auth.token('acme/project', 'read')).toMatchObject({ _tag: 'Ok', value: { installationId: 20 } })
    expect(await test.auth.token('acme/project', 'read')).toMatchObject({ _tag: 'Ok' })
    expect(await test.auth.token('acme/project', 'check')).toMatchObject({ _tag: 'Ok' })
    const mints = test.requests.filter(request => request.path.endsWith('/access_tokens'))
    expect(mints.map(request => request.body.repositories)).toEqual([['project'], ['project']])
    expect(mints[1]!.body.permissions).toEqual({ metadata: 'read', checks: 'write' })
    const token = mints[0]!.authorization.slice(7).split('.')
    expect(verify('RSA-SHA256', Buffer.from(`${token[0]}.${token[1]}`), publicKey, Buffer.from(token[2]!, 'base64url'))).toBe(true)
    expect(JSON.parse(Buffer.from(token[1]!, 'base64url').toString())).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: 7 })
  })

  it('rejects short or cross-repository grants before a repository read', async () => {
    const test = await fixture(request => request.path.endsWith('/access_tokens') ? { body: { token: 'rejected-token', expires_at: new Date(now + 3600_000).toISOString(), permissions: { metadata: 'read' }, repositories: [{ full_name: 'other/project' }] } } : undefined)
    expect(await test.client.snapshot('acme/project', 1)).toMatchObject({ _tag: 'Err', error: { _tag: 'Authorization' } })
    expect(test.requests.some(request => request.path === '/repos/acme/project/')).toBe(false)
  })

  it('returns a quota hold without refreshing credentials', async () => {
    const test = await fixture(request => request.path === '/repos/acme/project' ? { status: 403, body: {}, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 60) } } : undefined)
    expect(await test.client.repository('acme/project')).toEqual({ _tag: 'Err', error: { _tag: 'Capacity', message: 'GitHub rate limited this request.', retryAt: new Date(now + 60_000).toISOString() } })
    expect(test.requests.filter(request => request.path.endsWith('/access_tokens'))).toHaveLength(1)
  })

  it('refreshes a rejected credential once and rechecks the repository', async () => {
    let reads = 0
    const test = await fixture(request => request.path === '/repos/acme/project' && reads++ === 0 ? { status: 401, body: {} } : undefined)
    expect(await test.client.repository('acme/project')).toMatchObject({ _tag: 'Ok', value: { ref: repository } })
    expect(test.requests.filter(request => request.path.endsWith('/access_tokens'))).toHaveLength(2)
  })

  it('reads workflow configuration from a pinned default branch commit', async () => {
    const test = await fixture(request => request.path === '/repos/acme/project/commits/main'
      ? { body: { sha: base } }
      : request.path.startsWith('/repos/acme/project/contents/.github/octorun.yml')
        ? { body: { encoding: 'base64', size: 10, content: Buffer.from('version: 1').toString('base64') } }
        : undefined)
    expect(await test.client.readWorkflow('acme/project', '.github/octorun.yml')).toEqual({ _tag: 'Ok', value: { sha: base, text: 'version: 1' } })
    expect(test.requests.some(request => request.path === `/repos/acme/project/contents/.github/octorun.yml?ref=${base}`)).toBe(true)
  })

  it('uses the canonical repository endpoint without requiring a redirect', async () => {
    const test = await fixture(request => request.path === '/repos/acme/project/' ? { status: 301, headers: { location: '/repos/acme/project' }, body: {} } : undefined)
    expect(await test.client.repository('acme/project')).toMatchObject({ _tag: 'Ok', value: { ref: repository } })
  })

  it('rejects a snapshot that moves while its files are read', async () => {
    let move = () => {}
    const test = await fixture((request) => {
      if (request.path.startsWith('/repos/acme/project/pulls/1/files'))
        move()
      return undefined
    })
    move = () => test.moveHead('c'.repeat(40))
    expect(await createGitHubSnapshotReader(test.client).read('acme/project', { _tag: 'PullRequest', number: 1, headSha: head, baseSha: base }, new AbortController().signal)).toMatchObject({ _tag: 'Err', error: { message: 'The pull request changed during snapshot acquisition.' } })
  })
})

describe('gitHub publication reconciliation', () => {
  it('updates one App-owned overview and ignores copied markers from users', async () => {
    const test = await fixture()
    test.comments.push({ id: 1, user, body: `${overviewMarker('review')}\n${publicationMarker('first')}` })
    const publisher = createGitHubPublisher({ client: test.client })
    expect(await publisher.publish(publication({ _tag: 'Comment', repository: 'acme/project', number: 1, namespace: 'review', body: 'Review started.' }, 'first'))).toMatchObject({ _tag: 'Ok' })
    expect(await publisher.publish(publication({ _tag: 'Comment', repository: 'acme/project', number: 1, namespace: 'review', body: 'Review complete.' }, 'second'))).toMatchObject({ _tag: 'Ok' })
    expect(test.comments.map(comment => ({ id: comment.id, body: comment.body }))).toEqual([{ id: 1, body: `${overviewMarker('review')}\n${publicationMarker('first')}` }, { id: expect.any(Number), body: `Review complete.\n\n${overviewMarker('review')}\n${publicationMarker('second')}` }])
  })

  it('distinguishes publication identities when later runs reuse a task key', async () => {
    const test = await fixture()
    const publisher = createGitHubPublisher({ client: test.client })
    const first = publication({ _tag: 'Comment', repository: 'acme/project', number: 1, namespace: 'review', body: 'First run.' }, 'publication-one', 'run-one')
    first.publication.key = 'overview'
    const second = publication({ _tag: 'Comment', repository: 'acme/project', number: 1, namespace: 'review', body: 'Second run.' }, 'publication-two', 'run-two')
    second.publication.key = 'overview'
    expect(await publisher.publish(first)).toMatchObject({ _tag: 'Ok' })
    expect(await publisher.publish(second)).toMatchObject({ _tag: 'Ok' })
    expect(test.comments.map(comment => comment.body)).toEqual([`Second run.\n\n${overviewMarker('review')}\n${publicationMarker('publication-two')}`])
  })

  it('groups findings, supports removed lines, and recovers without duplicate findings', async () => {
    const test = await fixture()
    const publisher = createGitHubPublisher({ client: test.client })
    const context = publication({ _tag: 'Review', repository: 'acme/project', number: 1, headSha: head, body: 'Two findings.', comments: [{ fingerprint: 'left', path: 'src/a.ts', line: 1, side: 'LEFT', body: 'Removed check matters.' }, { fingerprint: 'right', path: 'src/a.ts', startLine: 2, line: 3, side: 'RIGHT', body: 'Range needs validation.' }] })
    const first = await publisher.publish(context)
    expect(first).toMatchObject({ _tag: 'Ok' })
    expect(await publisher.publish(context)).toEqual(first)
    expect(test.reviews).toHaveLength(1)
    expect(test.findings.map(finding => ({ side: finding.side, line: finding.line, start: finding.start_line }))).toEqual([{ side: 'LEFT', line: 1, start: undefined }, { side: 'RIGHT', line: 3, start: 2 }])
    const next = publication(context.publication.effect, 'new-result', 'run-2')
    expect(await publisher.publish(next)).toMatchObject({ _tag: 'Ok' })
    expect(test.findings).toHaveLength(2)
  })

  it('updates one check through queued, running, and timeout states', async () => {
    const test = await fixture()
    const publisher = createGitHubPublisher({ client: test.client })
    for (const phase of [{ status: 'queued' }, { status: 'in_progress' }, { status: 'completed', conclusion: 'timed_out' }] as const) {
      expect(await publisher.publish(publication({ _tag: 'Check', repository: 'acme/project', headSha: head, name: 'Octorun / Review', summary: 'Review status.', phase }, `check-${phase.status}`))).toMatchObject({ _tag: 'Ok' })
    }
    expect(test.checks.map(check => ({ status: check.status, conclusion: check.conclusion, externalId: check.external_id }))).toEqual([{ status: 'completed', conclusion: 'timed_out', externalId: 'octorun:run-1' }])
    expect(test.requests.filter(request => ['POST', 'PATCH'].includes(request.method) && request.path.includes('/check-runs')).map(request => request.body.actions)).toEqual([
      [{ label: 'Cancel', description: 'Cancel this workflow run.', identifier: 'cancel' }],
      [{ label: 'Cancel', description: 'Cancel this workflow run.', identifier: 'cancel' }],
      [{ label: 'Run again', description: 'Run this workflow again.', identifier: 'rerun' }],
    ])
  })

  it('blocks a stale head before creating a comment', async () => {
    const test = await fixture()
    test.moveHead('c'.repeat(40))
    const publisher = createGitHubPublisher({ client: test.client })
    expect(await publisher.publish(publication({ _tag: 'Comment', repository: 'acme/project', number: 1, namespace: 'review', body: 'Old result.' }))).toMatchObject({ _tag: 'Err', error: { _tag: 'Authorization' } })
    expect(test.comments).toEqual([])
  })

  it('can close a superseded head check without publishing its old result', async () => {
    const test = await fixture()
    test.moveHead('c'.repeat(40))
    const publisher = createGitHubPublisher({ client: test.client })
    const context = publication({ _tag: 'Check', repository: 'acme/project', headSha: head, name: 'Octorun / Review', phase: { status: 'completed', conclusion: 'cancelled' }, summary: 'A newer head superseded this run.' })
    expect(await publisher.publish(context)).toMatchObject({ _tag: 'Ok' })
    expect(test.checks.map(check => ({ head: check.head_sha, conclusion: check.conclusion }))).toEqual([{ head, conclusion: 'cancelled' }])
  })

  it('recovers an unknown write result without sending the comment twice', async () => {
    let saved: Record<string, unknown> | undefined
    const test = await fixture((request) => {
      if (request.path === '/repos/acme/project/issues/1/comments' && request.method === 'POST') {
        saved = { id: 400, user: bot, body: request.body.body }
        return { body: null, disconnect: true }
      }
      if (request.path.startsWith('/repos/acme/project/issues/1/comments?'))
        return { body: saved ? [saved] : [] }
      return undefined
    })
    const publisher = createGitHubPublisher({ client: test.client })
    const context = publication({ _tag: 'Comment', repository: 'acme/project', number: 1, namespace: 'review', body: 'Result.' })
    expect(await publisher.publish(context)).toMatchObject({ _tag: 'Err', error: { _tag: 'Transient' } })
    expect(await publisher.reconcile(context)).toEqual({ _tag: 'Ok', value: { id: '400', url: null, data: {} } })
    expect(await publisher.publish(context)).toEqual({ _tag: 'Ok', value: { id: '400', url: null, data: {} } })
    expect(test.requests.filter(request => request.method === 'POST' && request.path === '/repos/acme/project/issues/1/comments')).toHaveLength(1)
  })

  it('reconciles a partial review without repeating the existing finding', async () => {
    const test = await fixture()
    const publisher = createGitHubPublisher({ client: test.client })
    const context = publication({ _tag: 'Review', repository: 'acme/project', number: 1, headSha: head, body: 'Two findings.', comments: [{ fingerprint: 'a', path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'A.' }, { fingerprint: 'b', path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'B.' }] })
    expect(await publisher.publish(context)).toMatchObject({ _tag: 'Ok' })
    test.findings.pop()
    expect(await publisher.publish(context)).toMatchObject({ _tag: 'Ok' })
    expect(test.findings.map(comment => comment.line)).toEqual([1, 2])
    expect(test.reviews).toHaveLength(2)
  })

  it('checks live authority immediately before the write', async () => {
    const test = await fixture()
    let checks = 0
    const publisher = createGitHubPublisher({ client: test.client, authorize: async () => ++checks === 1 ? { _tag: 'Ok', value: undefined } : { _tag: 'Err', error: { _tag: 'Authorization', message: 'Permission revoked.' } } })
    expect(await publisher.publish(publication({ _tag: 'Comment', repository: 'acme/project', number: 1, namespace: 'review', body: 'Result.' }))).toEqual({ _tag: 'Err', error: { _tag: 'Authorization', message: 'Permission revoked.' } })
    expect(test.comments).toEqual([])
  })

  it('fetches an old finding root by ID and replies in that thread', async () => {
    const replies: unknown[] = []
    const test = await fixture((request) => {
      if (request.path === '/repos/acme/project/pulls/comments/5')
        return { body: { id: 5, user: bot, body: `Finding.\n\n${findingMarker('old-finding')}\n${publicationMarker('old-publication')}`, pull_request_url: 'https://api.github.com/repos/acme/project/pulls/1' } }
      if (request.path === '/repos/acme/project/pulls/1/comments/5/replies') {
        replies.push(request.body)
        return { body: { id: 6, user: bot, body: request.body.body } }
      }
      return undefined
    })
    const publisher = createGitHubPublisher({ client: test.client })
    expect(await publisher.publish(publication({ _tag: 'Reply', repository: 'acme/project', number: 1, commentId: 5, body: 'This check permits an invalid value.' }))).toMatchObject({ _tag: 'Ok', value: { id: '6' } })
    expect(replies).toEqual([{ body: `This check permits an invalid value.\n\n${publicationMarker('result')}` }])
    expect(test.reviews).toEqual([])
  })

  it('refuses to adopt another controller comment from the same App', async () => {
    const test = await fixture(request => request.path === '/repos/acme/project/pulls/comments/5' ? { body: { id: 5, user: bot, body: 'An older controller wrote this review.', pull_request_url: 'https://api.github.com/repos/acme/project/pulls/1' } } : undefined)
    const publisher = createGitHubPublisher({ client: test.client })
    expect(await publisher.publish(publication({ _tag: 'Reply', repository: 'acme/project', number: 1, commentId: 5, body: 'Answer.' }))).toMatchObject({ _tag: 'Err', error: { _tag: 'Authorization' } })
    expect(test.requests.some(request => request.method === 'POST' && request.path.endsWith('/replies'))).toBe(false)
  })
})

describe('gitHub event normalization', () => {
  it('verifies the raw body before accepting a webhook signature', () => {
    const body = '{"action":"opened"}'
    const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`
    expect(verifyWebhookSignature('secret', body, signature)).toBe(true)
    expect(verifyWebhookSignature('secret', `${body}\n`, signature)).toBe(false)
    expect(verifyWebhookSignature('secret', body, 'sha256=00')).toBe(false)
  })

  it('coalesces webhook and poll observations for the same fork head', async () => {
    const test = await fixture()
    const hook = await normalizeGitHubWebhook({ client: test.client, event: 'pull_request', delivery: 'delivery-1', payload: { action: 'synchronize', repository: { id: 10, full_name: 'acme/project' }, installation: { id: 20 }, pull_request: test.pr(), sender: user }, now: () => now })
    const poll = await pollGitHubEvents({ client: test.client, repository: 'acme/project', includeExisting: true, now: () => now })
    expect(hook).toMatchObject({ _tag: 'Ok', value: [{ target: { headSha: head, number: 1 }, repository }] })
    expect(poll).toMatchObject({ _tag: 'Ok' })
    if (hook._tag === 'Ok' && poll._tag === 'Ok') {
      expect(poll.value.events[0]!.semanticKey).toEqual(hook.value[0]!.semanticKey)
      expect(await pollGitHubEvents({ client: test.client, repository: 'acme/project', cursor: poll.value.cursor, now: () => now + 1000 })).toMatchObject({ _tag: 'Ok', value: { events: [] } })
    }
  })

  it('uses the comment editor as actor and ignores App echoes', async () => {
    const test = await fixture()
    const payload = { action: 'edited', repository: { id: 10, full_name: 'acme/project' }, installation: { id: 20 }, issue: { number: 1, pull_request: {} }, sender: { ...user, id: 31, login: 'bob' }, comment: { id: 3, user, body: '@octorun pause', updated_at: new Date(now).toISOString() } }
    expect(await normalizeGitHubWebhook({ client: test.client, event: 'issue_comment', delivery: 'edited-1', payload, now: () => now })).toMatchObject({ _tag: 'Ok', value: [{ actor: { id: 31, login: 'bob' }, data: { authorId: 30, body: '@octorun pause' } }] })
    expect(await normalizeGitHubWebhook({ client: test.client, event: 'issue_comment', delivery: 'edited-2', payload: { ...payload, comment: { ...payload.comment, user: bot } }, now: () => now })).toEqual({ _tag: 'Ok', value: [] })
  })

  it('requires a recorded run for an App-owned fork check rerun', async () => {
    const test = await fixture()
    const payload = { action: 'rerequested', repository: { id: 10, full_name: 'acme/project' }, installation: { id: 20 }, sender: user, check_run: { id: 99, app: { id: 7 }, head_sha: head, external_id: 'octorun:run-1', pull_requests: [] } }
    expect(await normalizeGitHubWebhook({ client: test.client, event: 'check_run', delivery: 'check-1', payload, now: () => now })).toMatchObject({ _tag: 'Err', error: { _tag: 'Authorization' } })
    expect(await normalizeGitHubWebhook({ client: test.client, event: 'check_run', delivery: 'check-2', payload, resolveCheckTarget: async () => ({ _tag: 'PullRequest', number: 1, headSha: head, baseSha: base }), now: () => now })).toMatchObject({ _tag: 'Ok', value: [{ target: { number: 1, headSha: head }, data: { command: 'rerun' } }] })
  })

  it('reads later comment pages and never treats an unknown editor as the author', async () => {
    const comments = Array.from({ length: 101 }, (_, index) => ({ id: index + 1, body: '@octorun status', user, issue_url: 'https://api.github.com/repos/acme/project/issues/1', created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() }))
    comments.push({ ...comments[0]!, id: 102, body: '@octorun pause', created_at: new Date(now - 10_000).toISOString() })
    const test = await fixture((request) => {
      if (request.path.startsWith('/repos/acme/project/issues/comments?')) {
        const page = Number(new URL(request.path, 'http://fixture').searchParams.get('page'))
        return { body: comments.slice((page - 1) * 100, page * 100) }
      }
      return undefined
    })
    const first = await pollGitHubEvents({ client: test.client, repository: 'acme/project', cursor: { version: 1, since: new Date(now - 60_000).toISOString(), pullRequests: {}, comments: {} }, now: () => now })
    expect(first).toMatchObject({ _tag: 'Ok' })
    if (first._tag === 'Ok') {
      expect(first.value.events.filter(event => event.name === 'issue_comment').map(event => event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data.commentId : null)).toEqual(Array.from({ length: 101 }, (_, index) => index + 1))
      const second = await pollGitHubEvents({ client: test.client, repository: 'acme/project', cursor: first.value.cursor, now: () => now + 1000 })
      expect(second).toMatchObject({ _tag: 'Ok', value: { events: [] } })
    }
  })
})
