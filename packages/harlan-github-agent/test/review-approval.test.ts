import type { Octokit } from 'octokit'
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createApprovalController } from '../src/approval-controller.ts'
import { createGitHubAgentSource } from '../src/github-agent-source.ts'
import { err, ok } from '../src/result.ts'
import { applyReviewApproval, REVIEW_APPROVAL_CONTROL, reviewApproval } from '../src/review-approval.ts'
import { AUTOMATED_REVIEW_MARKER } from '../src/review-comment.ts'
import { openJournalStore } from '../src/store.ts'
import { createWebhookApp } from '../src/webhook.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const at = '2026-10-02T00:00:00.000Z'
const headSha = 'a'.repeat(40)
const before = `${AUTOMATED_REVIEW_MARKER}\n<!-- reviewed-sha: ${headSha} -->\n### 🤖 REVIEW PAUSED\n\n${REVIEW_APPROVAL_CONTROL}`
const checked = before.replace('- [ ]', '- [x]')
function payload() {
  return { action: 'edited', repository: { full_name: 'harlan-zw/example' }, issue: { number: 24, pull_request: {} }, comment: { id: 42, body: checked, user: { login: 'harlan-github-agent[bot]' } }, changes: { body: { from: before } }, sender: { login: 'harlan-zw' } }
}

function fixture() {
  const store = openJournalStore(':memory:')
  const mapping = repositoryMapping()
  const subject = pullRequestItem({ author: 'contributor', headSha, mergeState: 'clean', baseRef: 'main' })
  store.syncRepositories([mapping], at)
  store.recordObservation({ externalId: 'open', observedAt: at, source: 'poll', subject })
  const revisionId = store.getDashboardSnapshot(at).items.find(item => item.number === 24)!.revisionId
  store.recordApprovalPromptComment({ repository: mapping.github, pullRequestNumber: 24, revisionId, commentId: 42, body: before, at })
  return { store, mapping, subject, revisionId }
}

describe('review Approval checkbox', () => {
  it('accepts only an isolated unchecked to checked transition', () => {
    expect(reviewApproval('issue_comment', payload())).toMatchObject({ headSha, commentId: 42, beforeBody: before, requestedBy: 'harlan-zw' })
    const modified = payload()
    modified.comment.body += '\nextra edit'
    expect(reviewApproval('issue_comment', modified)).toBeNull()
    modified.comment.body = before
    expect(reviewApproval('issue_comment', modified)).toBeNull()
    expect(reviewApproval('issues', payload())).toBeNull()
  })

  it.each(['valid', 'other-sender', 'other-bot', 'bad-signature', 'disabled'] as const)('authenticates the editor: %s', async (mode) => {
    const input = payload()
    if (mode === 'other-sender')
      input.sender.login = 'contributor'
    if (mode === 'other-bot')
      input.comment.user.login = 'other[bot]'
    const calls: unknown[] = []
    const secret = 'test-secret'
    const app = createWebhookApp({ secret, allowedOwners: ['harlan-zw'], logger: { info: () => undefined }, onHint: () => undefined, reviewApproval: { allowedAuthor: 'harlan-zw', actorLogin: () => mode === 'disabled' ? null : 'harlan-github-agent[bot]', apply: async (request) => {
      calls.push(request)
      return ok(undefined)
    } } })
    const body = JSON.stringify(input)
    const request = () => new Request('http://localhost/webhook', { method: 'POST', body, headers: { 'x-github-event': 'issue_comment', 'x-github-delivery': 'click-1', 'x-hub-signature-256': `sha256=${createHmac('sha256', mode === 'bad-signature' ? 'wrong' : secret).update(body).digest('hex')}` } })
    expect((await app.fetch(request())).status).toBe(mode === 'bad-signature' ? 401 : 204)
    await app.fetch(request())
    expect(calls).toEqual(mode === 'valid' ? [expect.objectContaining({ headSha, commentId: 42, requestId: 'click-1' })] : [])
  })

  it.each(['valid', 'wrong-comment', 'forged-body', 'new-head', 'closed', 'retargeted', 'approved', 'disabled'] as const)('adds the label only for the current recorded prompt: %s', async (mode) => {
    const { store, mapping, revisionId } = fixture()
    const request = reviewApproval('issue_comment', payload())!
    if (mode === 'wrong-comment')
      request.commentId++
    if (mode === 'forged-body')
      request.beforeBody += '\nforged'
    if (mode === 'approved')
      store.approvePullRequest({ repository: mapping.github, pullRequestNumber: 24, revisionId, kind: 'review', at })
    if (mode === 'disabled')
      mapping.enabled = false
    const labels: string[] = []
    const result = await applyReviewApproval({ store, github: {
      getPullRequestStatusIdentity: async () => ok({ state: mode === 'closed' ? 'closed' : 'open', headSha: mode === 'new-head' ? 'b'.repeat(40) : headSha, baseRef: mode === 'retargeted' ? 'next' : 'main' }),
      addApprovalLabel: async (_repository, _number, label) => {
        labels.push(label)
        return ok(undefined)
      },
    } }, mapping, request, new AbortController().signal)
    expect(result).toEqual(ok(undefined))
    expect(labels).toEqual(mode === 'valid' ? ['harlan-agent-review'] : [])
    store.close()
  })

  it('rejects a prompt when the journal has observed a new head', async () => {
    const { store, subject } = fixture()
    store.recordObservation({ externalId: 'new-head', observedAt: at, source: 'poll', subject: { ...subject, headSha: 'b'.repeat(40) } })
    expect(store.getApprovalPrompt(reviewApproval('issue_comment', payload())!)).toBeNull()
    store.close()
  })

  it('reports a failed label write for retry', async () => {
    const { store, mapping, subject } = fixture()
    expect(await applyReviewApproval({ store, github: {
      getPullRequestStatusIdentity: async () => ok(subject),
      addApprovalLabel: async () => err('GitHub unavailable'),
    } }, mapping, reviewApproval('issue_comment', payload())!, new AbortController().signal)).toEqual(err('GitHub unavailable'))
    store.close()
  })
})

it('retries a failed write without recording a successful delivery', async () => {
  const secret = 'retry-secret'
  let writes = 0
  const app = createWebhookApp({ secret, allowedOwners: ['harlan-zw'], logger: { info: () => undefined }, onHint: () => undefined, reviewApproval: { allowedAuthor: 'harlan-zw', actorLogin: () => 'harlan-github-agent[bot]', apply: async () => ++writes === 1 ? err('GitHub unavailable') : ok(undefined) } })
  const body = JSON.stringify(payload())
  const request = () => new Request('http://localhost/webhook', { method: 'POST', body, headers: { 'x-github-event': 'issue_comment', 'x-github-delivery': 'retry-click', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } })
  expect((await app.fetch(request())).status).toBe(503)
  expect((await app.fetch(request())).status).toBe(204)
  await app.fetch(request())
  expect(writes).toBe(2)
})

it('starts one Review through a signed click and the existing label Approval path', async () => {
  const { store, mapping, subject } = fixture()
  const labels: string[] = []
  const source = createGitHubAgentSource({
    ownAppId: 98114,
    actorLogin: () => 'harlan-github-agent[bot]',
    tokens: { getToken: async () => ok({ token: 'token', expiresAt: '2099-01-01T00:00:00.000Z' }), invalidate: () => undefined },
    createClient: () => ({ rest: {
      pulls: { get: async () => ({ data: { state: 'open', head: { sha: headSha }, base: { ref: 'main' } } }) },
      issues: { addLabels: async (input: { labels: string[] }) => {
        labels.push(...input.labels)
        return { data: labels.map(name => ({ name })) }
      } },
    } } as unknown as Octokit),
  })
  const secret = 'integration-secret'
  const app = createWebhookApp({ secret, allowedOwners: ['harlan-zw'], logger: { info: () => undefined }, onHint: () => undefined, reviewApproval: { allowedAuthor: 'harlan-zw', actorLogin: () => 'harlan-github-agent[bot]', apply: request => applyReviewApproval({ store, github: source }, mapping, request, new AbortController().signal) } })
  const body = JSON.stringify(payload())
  const request = () => new Request('http://localhost/webhook', { method: 'POST', body, headers: { 'x-github-event': 'issue_comment', 'x-github-delivery': 'integration-click', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } })
  expect((await app.fetch(request())).status).toBe(204)
  expect(labels).toEqual(['harlan-agent-review'])
  const labelled = { ...subject, approvalLabels: ['review'] as const }
  const observed = store.recordObservation({ externalId: 'labelled', observedAt: at, source: 'poll', subject: { ...labelled, approvalLabels: ['review'] } })
  if (observed._tag === 'Conflict')
    throw new Error('Unexpected observation conflict.')
  const controller = createApprovalController({ store, github: source, now: () => new Date(at) })
  expect(await controller.reconcile(mapping, { ...labelled, approvalLabels: ['review'] }, observed.revisionId, new AbortController().signal)).toEqual(ok(undefined))
  await app.fetch(request())
  expect(labels).toEqual(['harlan-agent-review'])
  expect(store.claimNextAdversarialReviewTask('reviewer', at, 60000)?.kind).toBe('adversarial_review')
  expect(store.claimNextAdversarialReviewTask('second-reviewer', at, 60000)).toBeNull()
  store.close()
})
