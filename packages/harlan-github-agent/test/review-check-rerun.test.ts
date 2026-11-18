import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { requestReviewCheckRerun } from '../src/review-check-rerun.ts'
import { REVIEW_CHECK_RUN_NAME } from '../src/review-check-run.ts'
import { openJournalStore } from '../src/store.ts'
import { createWebhookApp } from '../src/webhook.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const APP_ID = 4579275
const HEAD = 'a'.repeat(40)

describe('a Re-run click on the Review check run', () => {
  it.each(['valid', 'other-sender', 'other-app', 'other-check', 'other-action', 'short-head', 'bad-signature'])('reaches the controller only when valid: %s', async (mode) => {
    const requests: unknown[] = []
    const secret = 'test-secret'
    const payload = {
      action: mode === 'other-action' ? 'requested_action' : 'rerequested',
      repository: { full_name: 'harlan-zw/example' },
      sender: { login: mode === 'other-sender' ? 'contributor' : 'harlan-zw' },
      check_run: {
        name: mode === 'other-check' ? 'ci / test' : REVIEW_CHECK_RUN_NAME,
        head_sha: mode === 'short-head' ? 'abc123' : HEAD,
        app: { id: mode === 'other-app' ? 1 : APP_ID },
      },
    }
    const app = createWebhookApp({
      secret,
      allowedOwners: ['harlan-zw'],
      logger: { info: () => undefined },
      onHint: () => undefined,
      reviewCheckRerun: { allowedAuthor: 'harlan-zw', appId: () => APP_ID, apply: request => requests.push(request) },
    })
    const body = JSON.stringify(payload)
    const response = await app.fetch(new Request('http://localhost/webhook', {
      method: 'POST',
      body,
      headers: {
        'x-github-event': 'check_run',
        'x-github-delivery': 'rerun-1',
        'x-hub-signature-256': `sha256=${createHmac('sha256', mode === 'bad-signature' ? 'wrong-secret' : secret).update(body).digest('hex')}`,
      },
    }))
    expect(response.status).toBe(mode === 'bad-signature' ? 401 : 204)
    expect(requests).toEqual(mode === 'valid'
      ? [{ repository: 'harlan-zw/example', headSha: HEAD, appId: APP_ID, requestedBy: 'harlan-zw', requestId: 'rerun-1' }]
      : [])
  })

  it('reaches no controller when the repository has no Review check run', async () => {
    const requests: unknown[] = []
    const secret = 'test-secret'
    const body = JSON.stringify({ action: 'rerequested', repository: { full_name: 'harlan-zw/example' }, sender: { login: 'harlan-zw' }, check_run: { name: REVIEW_CHECK_RUN_NAME, head_sha: HEAD, app: { id: APP_ID } } })
    const app = createWebhookApp({
      secret,
      allowedOwners: ['harlan-zw'],
      logger: { info: () => undefined },
      onHint: () => undefined,
      reviewCheckRerun: { allowedAuthor: 'harlan-zw', appId: () => null, apply: request => requests.push(request) },
    })
    await app.fetch(new Request('http://localhost/webhook', { method: 'POST', body, headers: { 'x-github-event': 'check_run', 'x-github-delivery': 'rerun-2', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } }))
    expect(requests).toEqual([])
  })
})

describe('queueing Review from a Re-run click', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function openStore() {
    const directory = mkdtempSync(join(tmpdir(), 'review-check-rerun-'))
    directories.push(directory)
    const store = openJournalStore(join(directory, 'journal.sqlite'))
    store.syncRepositories([repositoryMapping()], '2026-11-18T00:00:00.000Z')
    store.recordObservation({ externalId: 'open', observedAt: '2026-11-18T01:00:00.000Z', source: 'poll', subject: pullRequestItem({ headSha: HEAD, mergeState: 'clean' }) })
    return store
  }

  const click = { repository: 'harlan-zw/example', headSha: HEAD, appId: APP_ID, requestedBy: 'harlan-zw', requestId: 'rerun-1', at: '2026-11-18T01:01:00.000Z' }

  it('requests Review for the open pull request at the clicked head', () => {
    const store = openStore()
    expect(requestReviewCheckRerun(store, click)).toEqual([{ _tag: 'AlreadyQueued', taskId: expect.any(String) }])
  })

  it('never applies one delivery twice', () => {
    const store = openStore()
    requestReviewCheckRerun(store, click)
    expect(requestReviewCheckRerun(store, click)).toEqual([{ _tag: 'Duplicate', taskId: expect.any(String) }])
  })

  it('requests nothing when the pull request has moved past the clicked head', () => {
    const store = openStore()
    expect(requestReviewCheckRerun(store, { ...click, headSha: 'b'.repeat(40) })).toEqual([])
  })

  it('keeps the trusted author rule of a rerun comment', () => {
    const store = openStore()
    expect(requestReviewCheckRerun(store, { ...click, requestedBy: 'contributor' }))
      .toEqual([{ _tag: 'Rejected', reason: { _tag: 'AuthorNotAllowed' } }])
  })
})
