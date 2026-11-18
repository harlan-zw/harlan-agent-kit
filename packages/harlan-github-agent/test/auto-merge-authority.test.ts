import type { Octokit } from 'octokit'
import type { AutoMergeControllerOptions, AutoMergeEvent } from '../src/auto-merge-controller.ts'
import type { GitHubPullRequestItem, RepositoryMapping, ReviewGates } from '../src/types.ts'
import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitHubPullRequestMerger } from '../src/github.ts'
import { createAutoMergeController, openJournalStore } from '../src/index.ts'
import { ok } from '../src/result.ts'
import { REVIEW_AUTO_MERGE_CONTROL, withReviewAutoMergeControl } from '../src/review-auto-merge.ts'
import { AUTOMATED_REVIEW_MARKER } from '../src/review-comment.ts'
import { createWebhookApp } from '../src/webhook.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
afterEach(() => stores.splice(0).forEach(store => store.close()))
const started = '2026-08-13T01:00:00.000Z'
const changed = '2026-08-13T01:01:00.000Z'
const gates: ReviewGates = {
  merge: { _tag: 'Passed', evidence: [] },
  review: { _tag: 'Passed', evidence: [] },
  ci: { _tag: 'Passed', evidence: [] },
}

function harness(boundary: 'enable' | 'fallback' | 'retarget', every = false, source: 'label' | 'comment' = 'label') {
  const store = openJournalStore(':memory:', true)
  stores.push(store)
  const repository = repositoryMapping(every ? { autoMerge: { _tag: 'Every', minimumConfidence: 90 } } : {})
  const pullRequest = pullRequestItem({ autoMerge: !every && source === 'label', headSha: 'a'.repeat(40), mergeState: 'clean', baseRef: boundary === 'retarget' ? 'fix/parent' : 'main' })
  const confidence = source === 'comment' ? 81 : 95
  const reviewBody = withReviewAutoMergeControl(`${AUTOMATED_REVIEW_MARKER}\n<!-- reviewed-sha: ${pullRequest.headSha} -->\n### 🤖 READY · ${confidence}/100`, repository, pullRequest, confidence, undefined)
  store.syncRepositories([repository], started)
  store.setRepositoryWritesEnabled(repository.github, true)
  const observation = store.recordObservation({ externalId: 'initial', observedAt: started, source: 'poll', subject: pullRequest })
  if (observation._tag !== 'Inserted')
    throw new Error('Expected the pull request Revision.')
  const task = store.claimNextAdversarialReviewTask('reviewer', started, 60_000)!

  const recordReview = (id: string, at: string) => store.recordReviewRun({
    id,
    repository: repository.github,
    pullRequestNumber: pullRequest.number,
    revisionId: observation.revisionId,
    headSha: pullRequest.headSha,
    provider: 'codex',
    sessionId: 'session',
    model: 'gpt-5.6-sol',
    agentVersion: '0.0.0',
    skillDigest: 'd'.repeat(64),
    startedAt: started,
    completedAt: at,
    gates,
    confidence,
    findings: [],
  })
  expect(recordReview('review', started)._tag).toBe('Inserted')
  expect(store.completeReviewTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: started, evidence: 'review', resolution: { _tag: 'Reviewed', reviewRunId: 'review' } })).toBe(true)

  const publish = (reviewRunId: string, at: string) => {
    const staged = store.stageReviewGateStatus({
      reviewRunId,
      repository: repository.github,
      pullRequestNumber: pullRequest.number,
      revisionId: observation.revisionId,
      expectedHeadSha: pullRequest.headSha,
      gates,
      body: reviewBody,
      desiredOutcome: 'READY',
      at,
    })
    if (staged._tag === 'Rejected')
      throw new Error(staged.reason)
    const command = store.claimNextTerminalReviewStatus('publisher', at, 60_000)!
    expect(store.completeReviewStatus({ commandId: command.id, workerId: command.workerId, fence: command.fence, at, commentId: 42, url: pullRequest.url })).toBe(true)
  }
  publish('review', started)

  const mutations: string[] = []
  const events: AutoMergeEvent[] = []
  let duringRead = () => {}
  let finalRead = false
  let reads = 0
  const comment = { body: reviewBody.replace('[ ]', '[x]') }
  const current = {
    node_id: 'PR_node_1',
    state: 'open',
    draft: false,
    merged_at: null as string | null,
    user: { login: pullRequest.author },
    head: { sha: pullRequest.headSha, repo: { full_name: repository.github } },
    base: { ref: pullRequest.baseRef, sha: pullRequest.baseSha, repo: { full_name: repository.github } },
    labels: pullRequest.autoMerge ? [{ name: 'harlan-agent-auto-merge' }] : [],
  }
  const options: AutoMergeControllerOptions = {
    policy: { _tag: 'Enabled', minimumConfidence: 90, method: 'squash' },
    store,
    report: event => events.push(event),
    merger: createGitHubPullRequestMerger({
      tokens: { getToken: async () => ok({ token: 'token', expiresAt: '2126-01-01T00:00:00.000Z' }), invalidate: () => undefined },
      createClient: () => ({
        graphql: async () => {
          mutations.push('enable')
          if (boundary === 'fallback') {
            await Promise.resolve()
            if (!finalRead)
              duringRead()
            throw new Error('Pull request is in clean status')
          }
          return {}
        },
        rest: { issues: { getComment: async ({ comment_id }: { comment_id: number }) => {
          if (comment_id !== 42)
            throw new Error('Comment not found.')
          return { data: structuredClone(comment) }
        } }, pulls: {
          get: async () => {
            reads++
            await Promise.resolve()
            if (boundary === 'enable' || (finalRead && reads === 2))
              duringRead()
            return { data: structuredClone(current) }
          },
          list: async () => {
            await Promise.resolve()
            if (!finalRead)
              duringRead()
            return { data: [{ merged_at: started, head: { sha: pullRequest.baseSha, repo: { full_name: repository.github } }, base: { ref: repository.defaultBranch } }] }
          },
          update: async () => {
            mutations.push('retarget')
            return { data: { base: { ref: repository.defaultBranch } } }
          },
          merge: async () => {
            mutations.push('merge')
            return { data: { merged: true, sha: 'merged' } }
          },
        } },
      }) as unknown as Octokit,
    }),
  }
  const observe = (overrides: Partial<GitHubPullRequestItem>) => store.recordObservation({ externalId: 'changed', observedAt: changed, source: 'poll', subject: { ...pullRequest, ...overrides } })
  const policy = (overrides: Partial<RepositoryMapping>) => store.syncRepositories([{ ...repository, ...overrides }], changed)
  return {
    store,
    repository,
    pullRequest,
    options,
    current,
    comment,
    mutations,
    events,
    observe,
    policy,
    recordReview,
    reviewBody,
    publish,
    run(change = () => {}, duringFinalRead = false) {
      duringRead = change
      finalRead = duringFinalRead
      return createAutoMergeController(options).reconcile(repository, pullRequest, new AbortController().signal)
    },
  }
}

describe('auto merge requested from a READY Review', () => {
  it('hands off an authenticated owner click once at 81 confidence without a label', async () => {
    const test = harness('enable', false, 'comment')
    const secret = 'webhook-secret'
    const app = createWebhookApp({
      allowedOwners: ['harlan-zw'],
      logger: { info() {} },
      onHint() {},
      reviewAutoMerge: {
        allowedAuthor: 'harlan-zw',
        actorLogin: () => 'harlan-github-agent[bot]',
        apply: (request) => { test.store.requestReviewAutoMerge({ ...request, at: changed }, test.options.policy) },
      },
      secret,
    })
    const checked = test.reviewBody.replace(REVIEW_AUTO_MERGE_CONTROL, REVIEW_AUTO_MERGE_CONTROL.replace('[ ]', '[x]'))
    const click = async (sender: string, before: string, commentId: number, delivery: string, at = started, selection: 'checked' | 'unchecked' = 'checked') => {
      const after = selection === 'checked'
        ? before.replace(REVIEW_AUTO_MERGE_CONTROL, REVIEW_AUTO_MERGE_CONTROL.replace('[ ]', '[x]'))
        : test.reviewBody
      const body = JSON.stringify({
        action: 'edited',
        repository: { full_name: test.repository.github },
        issue: { number: test.pullRequest.number, pull_request: {} },
        comment: { id: commentId, user: { login: 'harlan-github-agent[bot]' }, body: after, updated_at: at },
        changes: { body: { from: before } },
        sender: { login: sender },
      })
      await app.fetch(new Request('http://localhost/webhook', { method: 'POST', headers: { 'x-github-event': 'issue_comment', 'x-github-delivery': delivery, 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` }, body }))
    }

    await click('contributor', test.reviewBody, 42, 'outside')
    await click('harlan-zw', `${test.reviewBody}\nModified body`, 42, 'modified')
    await click('harlan-zw', test.reviewBody, 41, 'old-comment')
    await test.run()
    expect(test.mutations).toEqual([])
    await click('harlan-zw', test.reviewBody, 42, 'owner')
    await click('harlan-zw', checked, 42, 'withdrawn', started, 'unchecked')
    await click('harlan-zw', test.reviewBody, 42, 'late-replay')
    await test.run()
    expect(test.mutations).toEqual([])
    await click('harlan-zw', test.reviewBody, 42, 'selected-again', changed)
    await test.run()
    await click('harlan-zw', test.reviewBody, 42, 'repeat', changed)
    await test.run()
    expect(test.mutations).toEqual(['merge'])
  })
})

type Harness = ReturnType<typeof harness>

async function ownerSelection(test: Harness, selected: boolean, at: string) {
  const secret = 'local-webhook-secret'
  const app = createWebhookApp({
    allowedOwners: ['harlan-zw'],
    logger: { info() {} },
    onHint() {},
    secret,
    reviewAutoMerge: {
      allowedAuthor: 'harlan-zw',
      actorLogin: () => 'harlan-github-agent[bot]',
      apply: (request) => { test.store.requestReviewAutoMerge({ ...request, at }, test.options.policy) },
    },
  })
  const checked = test.reviewBody.replace('[ ]', '[x]')
  const body = JSON.stringify({
    action: 'edited',
    repository: { full_name: test.repository.github },
    issue: { number: test.pullRequest.number, pull_request: {} },
    comment: { id: 42, user: { login: 'harlan-github-agent[bot]' }, body: selected ? checked : test.reviewBody, updated_at: at },
    changes: { body: { from: selected ? test.reviewBody : checked } },
    sender: { login: 'harlan-zw' },
  })
  const response = await app.fetch(new Request('http://localhost/webhook', {
    method: 'POST',
    body,
    headers: { 'x-github-event': 'issue_comment', 'x-github-delivery': `${selected}-${at}`, 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
  }))
  expect(response.status).toBe(204)
}

it.each(['repository', 'global'] as const)('honors a signed withdrawal during %s Pause after resume', async (pause) => {
  const test = harness('enable', false, 'comment')
  await ownerSelection(test, true, started)
  if (pause === 'repository')
    test.store.setRepositoryPaused(test.repository.github, true)
  else
    test.store.pauseAgents(changed)
  await ownerSelection(test, false, changed)
  if (pause === 'repository')
    test.store.setRepositoryPaused(test.repository.github, false)
  else
    test.store.resumeAgents(changed)
  await test.run()
  expect(test.mutations).toEqual([])
})

it.each(['unchecked', 'removed', 'replaced'] as const)('blocks a live %s comment while its withdrawal delivery is delayed', async (state) => {
  const test = harness('enable', false, 'comment')
  await ownerSelection(test, true, started)
  test.comment.body = state === 'unchecked'
    ? test.reviewBody
    : state === 'removed' ? '' : test.comment.body.replace(test.pullRequest.headSha, 'b'.repeat(40))
  await test.run()
  expect(test.mutations).toEqual([])
})

it('does not borrow new checkbox consent for an in-flight label handoff', async () => {
  const test = harness('enable')
  await test.run(() => {
    test.current.labels = []
    expect(test.store.requestReviewAutoMerge({
      repository: test.repository.github,
      pullRequestNumber: test.pullRequest.number,
      headSha: test.pullRequest.headSha,
      commentId: 42,
      beforeBody: test.reviewBody,
      requestedBy: 'harlan-zw',
      commentAuthor: 'harlan-github-agent[bot]',
      selection: 'Selected',
      updatedAt: Date.parse(changed),
      at: changed,
    }, test.options.policy)).toBe(true)
  })
  expect(test.mutations).toEqual([])
  await test.run()
  expect(test.mutations).toEqual(['merge'])
})

const revocations: Array<[string, (test: Harness) => void]> = [
  ['Pause', test => test.store.setRepositoryPaused(test.repository.github, true)],
  ['global Pause', test => test.store.pauseAgents(changed)],
  ['Dismissal', test => test.store.dismissItem({ repository: test.repository.github, itemNumber: test.pullRequest.number, at: changed })],
  ['writes disabled', test => test.store.setRepositoryWritesEnabled(test.repository.github, false)],
  ['Review disabled', test => test.policy({ pullRequestReview: false })],
  ['repository disabled', test => test.policy({ enabled: false })],
  ['ownership removed', test => test.policy({ ownership: 'maintained' })],
  ['author trust removed', test => test.policy({ writablePullRequestAuthors: ['someone-else'] })],
  ['default branch replaced', test => test.policy({ defaultBranch: 'next' })],
  ['Auto merge disabled', (test) => { test.options.policy = { _tag: 'Disabled' } }],
  ['head replaced', test => test.observe({ headSha: 'new-head' })],
  ['base replaced', test => test.observe({ baseRef: 'other-base' })],
  ['author replaced', test => test.observe({ author: 'outside' })],
  ['draft', test => test.observe({ draft: true })],
  ['closed', test => test.observe({ state: 'closed' })],
]
const reviewRevocations: Array<[string, (test: Harness) => void]> = [
  ['minimum confidence raised', (test) => { test.options.policy = { _tag: 'Enabled', minimumConfidence: 100, method: 'squash' } }],
  ['merge method replaced', (test) => { test.options.policy = { _tag: 'Enabled', minimumConfidence: 90, method: 'merge' } }],
  ['Review replaced', (test) => {
    expect(test.recordReview('replacement', changed)._tag).toBe('Inserted')
    test.publish('replacement', changed)
  }],
  ['Publication replaced', test => test.publish('review', changed)],
  ['Publication revoked', test => test.store.recordReviewPublication({ id: 'replacement', reviewRunId: 'review', at: changed, body: 'PENDING', result: { _tag: 'Published', githubCommentId: 42, url: test.pullRequest.url } })],
  ['mergeable state replaced', test => test.observe({ mergeState: 'conflicting' })],
]
const liveRevocations: Array<[string, (test: Harness) => void]> = [
  ['label removed', (test) => { test.current.labels = [] }],
  ['head replaced', (test) => { test.current.head.sha = 'new-head' }],
  ['base replaced', (test) => { test.current.base.ref = 'other-base' }],
  ['draft', (test) => { test.current.draft = true }],
  ['closed', (test) => { test.current.state = 'closed' }],
  ['merged', (test) => { test.current.merged_at = changed }],
  ['author replaced', (test) => { test.current.user.login = 'outside' }],
  ['head repository replaced', (test) => { test.current.head.repo.full_name = 'outside/fork' }],
  ['base repository replaced', (test) => { test.current.base.repo.full_name = 'outside/fork' }],
]

describe.each(['enable', 'fallback', 'retarget'] as const)('current Auto merge authority before %s', (boundary) => {
  it.each(liveRevocations)('refuses after GitHub reports %s during the final read', async (_name, revoke) => {
    const test = harness(boundary)
    await test.run(() => revoke(test))
    expect(test.mutations).toEqual(boundary === 'fallback' ? ['enable'] : [])
  })

  it.each(boundary === 'retarget' ? revocations : [...revocations, ...reviewRevocations])('refuses after %s during the final read', async (_name, revoke) => {
    const test = harness(boundary)
    await test.run(() => revoke(test))
    expect(test.mutations).toEqual(boundary === 'fallback' ? ['enable'] : [])
    expect(test.events).not.toContainEqual(expect.objectContaining({ _tag: boundary === 'retarget' ? 'Retargeted' : boundary === 'fallback' ? 'Merged' : 'AutoMergeEnabled' }))
  })

  if (boundary !== 'enable') {
    it.each(boundary === 'retarget' ? revocations : [...revocations, ...reviewRevocations])('refuses after %s during the final pull request GET', async (_name, revoke) => {
      const test = harness(boundary)
      await test.run(() => revoke(test), true)
      expect(test.mutations).toEqual(boundary === 'fallback' ? ['enable'] : [])
    })
  }

  it('refuses when the current repository policy requires a missing label', async () => {
    const test = harness(boundary, true)
    await test.run(() => test.policy({ autoMerge: { _tag: 'Labelled', minimumConfidence: null } }))
    expect(test.mutations).toEqual(boundary === 'fallback' ? ['enable'] : [])
  })

  if (boundary !== 'retarget') {
    it('uses the current repository minimum confidence', async () => {
      const test = harness(boundary, true)
      await test.run(() => test.policy({ autoMerge: { _tag: 'Every', minimumConfidence: 100 } }))
      expect(test.mutations).toEqual(boundary === 'fallback' ? ['enable'] : [])
    })
  }

  it.each([false, true])('writes with current authority, every pull request: %s', async (every) => {
    const test = harness(boundary, every)
    await test.run()
    expect(test.mutations).toEqual(boundary === 'fallback' ? ['enable', 'merge'] : [boundary])
    expect(test.events).toEqual([expect.objectContaining({ _tag: boundary === 'retarget' ? 'Retargeted' : boundary === 'fallback' ? 'Merged' : 'AutoMergeEnabled' })])
  })
})

it('refuses to retarget when the parent branch advances during its merge lookup', async () => {
  const test = harness('retarget')
  await test.run(() => {
    test.current.base.sha = 'unmerged-parent'
  })
  expect(test.mutations).toEqual([])
})
