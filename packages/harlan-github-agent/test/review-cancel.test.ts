import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REVIEW_CANCEL_CONTROL } from '../src/review-cancel.ts'
import { openJournalStore } from '../src/store.ts'
import { createWebhookApp } from '../src/webhook.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

it.each(['valid', 'other-author', 'wrong-comment-author', 'changed-head', 'bad-signature'])('handles checkbox click: %s', async (mode) => {
  const requests: unknown[] = []
  const secret = 'test-secret'
  const before = `<!-- harlan-agent-kit:pr-triage -->\n<!-- reviewed-sha: ${'a'.repeat(40)} -->\n${REVIEW_CANCEL_CONTROL}`
  const payload = { action: 'edited', repository: { full_name: 'harlan-zw/example' }, issue: { number: 24, pull_request: {} }, sender: { login: 'harlan-zw' }, comment: { id: 42, user: { login: 'harlan-github-agent[bot]' }, body: before.replace('[ ]', '[x]') }, changes: { body: { from: before } } }
  if (mode === 'other-author')
    payload.sender.login = 'contributor'
  if (mode === 'wrong-comment-author')
    payload.comment.user.login = 'contributor'
  if (mode === 'changed-head')
    payload.comment.body = payload.comment.body.replace('a'.repeat(40), 'b'.repeat(40))
  const app = createWebhookApp({ secret, allowedOwners: ['harlan-zw'], logger: { info: () => undefined }, onHint: () => undefined, reviewCancellation: { actorLogin: () => 'harlan-github-agent[bot]', apply: request => requests.push(request) } })
  const body = JSON.stringify(payload)
  const response = await app.fetch(new Request('http://localhost/webhook', { method: 'POST', headers: { 'x-github-event': 'issue_comment', 'x-github-delivery': 'click-1', 'x-hub-signature-256': `sha256=${createHmac('sha256', mode === 'bad-signature' ? 'wrong-secret' : secret).update(body).digest('hex')}` }, body }))
  expect(response.status).toBe(mode === 'bad-signature' ? 401 : 204)
  expect(requests).toEqual(mode === 'valid' ? [expect.objectContaining({ headSha: 'a'.repeat(40), requestedBy: 'harlan-zw', requestId: 'click-1', commentId: 42 })] : [])
})

describe('durable Review cancellation', () => {
  it('rejects stale controls and never applies one click twice', () => {
    const directory = mkdtempSync(join(tmpdir(), 'review-cancel-'))
    const path = join(directory, 'journal.sqlite')
    let store = openJournalStore(path)
    const mapping = repositoryMapping()
    const subject = pullRequestItem({ headSha: 'a'.repeat(40), mergeState: 'clean' })
    store.syncRepositories([mapping], '2026-08-13T00:00:00.000Z')
    store.recordObservation({ externalId: 'open', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject })
    const task = store.claimNextAdversarialReviewTask('reviewer', '2026-08-13T01:00:01.000Z', 60000)!
    const request = { repository: mapping.github, pullRequestNumber: 24, headSha: subject.headSha, requestId: 'click-1', requestedBy: 'harlan-zw', at: '2026-08-13T01:00:02.000Z' }
    expect(store.cancelReviewForHead({ ...request, headSha: 'b'.repeat(40) })).toBe(false)
    expect(store.cancelReviewForHead(request)).toBe(true)
    store.recordExactPullRequestObservation({ externalId: 'merge-after-cancel', observedAt: '2026-08-13T01:00:03.000Z', subject: { ...subject, state: 'closed', mergedAt: '2026-08-13T01:00:03.000Z' } })
    expect(store.heartbeatWorkerTask({ taskId: task.id, workerId: 'reviewer', fence: task.state.fence, at: request.at, leaseMilliseconds: 60000 })).toBe(false)
    store.close()
    store = openJournalStore(path)
    expect(store.cancelReviewForHead(request)).toBe(false)
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
})

describe('stop Service Review for a subagent', () => {
  it('stops a queued Service Review for one head and does not requeue it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'review-handoff-'))
    const path = join(directory, 'journal.sqlite')
    const store = openJournalStore(path)
    const mapping = repositoryMapping()
    const subject = pullRequestItem({ headSha: 'a'.repeat(40), mergeState: 'clean' })
    const at = '2026-08-13T01:00:00.000Z'
    store.syncRepositories([mapping], at)
    store.recordObservation({ externalId: 'open', observedAt: at, source: 'poll', subject })
    expect(store.stopReviewForHead({ repository: mapping.github, pullRequestNumber: 24, headSha: 'b'.repeat(40), at })).toEqual({ _tag: 'Rejected', reason: 'HeadChanged' })
    expect(store.stopReviewForHead({ repository: mapping.github, pullRequestNumber: 24, headSha: subject.headSha, at })).toEqual({ _tag: 'Stopped' })
    expect(store.stopReviewForHead({ repository: mapping.github, pullRequestNumber: 24, headSha: subject.headSha, at })).toEqual({ _tag: 'AlreadyStopped' })
    store.recordObservation({ externalId: 'again', observedAt: '2026-08-13T01:01:00.000Z', source: 'poll', subject })
    expect(store.claimNextAdversarialReviewTask('reviewer', '2026-08-13T01:01:01.000Z', 60000)).toBeNull()
    expect(store.getDashboardSnapshot('2026-08-13T01:01:02.000Z').queue.some(item => item.repository === mapping.github && item.number === 24)).toBe(false)
    const next = { ...subject, headSha: 'c'.repeat(40), updatedAt: '2026-08-13T01:02:00.000Z' }
    store.recordObservation({ externalId: 'next-head', observedAt: next.updatedAt, source: 'poll', subject: next })
    expect(store.claimNextAdversarialReviewTask('reviewer', '2026-08-13T01:02:01.000Z', 60000)?.kind).toBe('adversarial_review')
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('leaves a Running Service Review in charge', () => {
    const store = openJournalStore(':memory:')
    const mapping = repositoryMapping()
    const subject = pullRequestItem({ headSha: 'a'.repeat(40), mergeState: 'clean' })
    const at = '2026-08-13T01:00:00.000Z'
    store.syncRepositories([mapping], at)
    store.recordObservation({ externalId: 'open', observedAt: at, source: 'poll', subject })
    expect(store.claimNextAdversarialReviewTask('reviewer', at, 60000)?.kind).toBe('adversarial_review')
    expect(store.stopReviewForHead({ repository: mapping.github, pullRequestNumber: 24, headSha: subject.headSha, at })).toEqual({ _tag: 'Rejected', reason: 'ReviewRunning' })
    store.close()
  })
})
