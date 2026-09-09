import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { err, ok } from '../src/result.ts'
import { publishClaimedReviewStatus } from '../src/review-status-controller.ts'
import { createReviewStatusScheduler } from '../src/review-status-scheduler.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []
const directories: string[] = []

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
})

function stagedTerminalStatus(path = ':memory:') {
  const store = openJournalStore(path)
  stores.push(store)
  const repository = repositoryMapping()
  const pullRequest = pullRequestItem({ mergeState: 'clean' })
  store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
  const observed = store.recordObservation({
    externalId: 'detached-terminal-status',
    observedAt: '2026-08-13T01:00:00.000Z',
    source: 'poll',
    subject: pullRequest,
  })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected a pull request.')
  const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:01:00.000Z', 60_000)
  if (task === null)
    throw new Error('Expected a Review Task.')
  const gates = {
    merge: { _tag: 'Passed' as const, evidence: [] },
    review: { _tag: 'Passed' as const, evidence: [] },
    ci: { _tag: 'Passed' as const, evidence: [] },
  }
  expect(store.recordReviewRun({
    id: 'review-1',
    repository: repository.github,
    pullRequestNumber: pullRequest.number,
    revisionId: task.revisionId,
    headSha: pullRequest.headSha,
    provider: 'codex',
    sessionId: 'session',
    model: 'gpt-5.6',
    agentVersion: '1.2.3',
    skillDigest: 'a'.repeat(64),
    startedAt: '2026-08-13T01:01:00.000Z',
    completedAt: '2026-08-13T01:01:05.000Z',
    gates,
    confidence: 96,
    findings: [],
  })._tag).toBe('Inserted')
  const staged = store.stageReviewStatus({
    taskKind: 'adversarial_review',
    phase: 'terminal',
    taskId: task.id,
    workerId: task.state.workerId,
    fence: task.state.fence,
    at: '2026-08-13T01:01:10.000Z',
    revisionId: observed.revisionId,
    expectedHeadSha: pullRequest.headSha,
    body: '<!-- harlan-agent-kit:pr-triage -->\n### 🤖 READY · 96/100',
    reviewRunId: 'review-1',
    gates,
    desiredOutcome: 'READY',
  })
  if (staged._tag === 'Rejected')
    throw new Error(staged.reason)
  store.completeWorkerTask({
    taskId: task.id,
    workerId: task.state.workerId,
    fence: task.state.fence,
    at: '2026-08-13T01:01:20.000Z',
    evidence: 'review-1',
  })
  return { pullRequest, repository, staged, store }
}

function snapshot(pullRequest: ReturnType<typeof pullRequestItem>) {
  return {
    baseChecks: { _tag: 'Available' as const, checks: [] },
    body: '',
    checks: { _tag: 'Available' as const, checks: [] },
    comments: [],
    priorAutomatedReview: { _tag: 'None' as const },
    pullRequest,
    requiredChecks: { _tag: 'None' as const },
    reviews: [],
  }
}

describe('review status scheduler', () => {
  it('retires a legacy status without a recorded base branch before any GitHub write', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'legacy-review-status-'))
    directories.push(directory)
    const path = join(directory, 'journal.sqlite')
    const test = stagedTerminalStatus(path)
    // Old Revision payloads can lack the base branch that current observations record.
    const legacy = new DatabaseSync(path)
    legacy.exec('UPDATE revisions SET payload = json_remove(payload, \'$.baseRef\')')
    legacy.close()
    const command = test.store.claimNextTerminalReviewStatus('publisher', '2026-08-13T01:01:30.000Z', 60_000)!
    expect(command).not.toBeNull()
    const writes: string[] = []

    const result = await publishClaimedReviewStatus({
      store: test.store,
      now: () => new Date('2026-08-13T01:01:31.000Z'),
      github: {
        readExistingReviewLabel: () => { throw new Error('Unexpected existing review.') },
        getPullRequestReviewSnapshot: () => Promise.resolve(ok(snapshot(test.pullRequest))),
        upsertReviewStatus: () => {
          writes.push('comment')
          return Promise.resolve(ok({ commentId: 42, url: test.pullRequest.url }))
        },
        stampAgentLabel: () => {
          writes.push('label')
          return Promise.resolve(ok(undefined))
        },
      },
    }, command, false, new AbortController().signal)

    expect(writes).toEqual([])
    expect(result._tag).toBe('Err')
    expect(test.store.listWorkflowEvents({ stream: 'review_status', limit: 20 }).map(event => event.event)).not.toContain('Published')
    expect(test.store.claimNextTerminalReviewStatus('next-publisher', '2026-08-13T01:02:00.000Z', 60_000)).toBeNull()
  })

  it('publishes terminal status after the Agent Task completed', async () => {
    const test = stagedTerminalStatus()
    const bodies: string[] = []
    const labels: string[] = []
    const failures: string[] = []
    const published: string[] = []
    const scheduler = createReviewStatusScheduler({
      github: {
        readExistingReviewLabel: () => { throw new Error('Unexpected existing review.') },
        getPullRequestReviewSnapshot: () => Promise.resolve(ok(snapshot(test.pullRequest))),
        upsertReviewStatus: (_repository, _number, _commentId, body) => {
          bodies.push(body)
          return Promise.resolve(ok({ commentId: 42, url: `${test.pullRequest.url}#issuecomment-42` }))
        },
        stampAgentLabel: (_repository, _number, label) => {
          labels.push(label)
          return Promise.resolve(ok(undefined))
        },
      },
      intervalMilliseconds: 5_000,
      leaseMilliseconds: 60_000,
      now: () => new Date('2026-08-13T01:01:30.000Z'),
      onError: (error) => { throw error },
      onFailure: (_repository, _number, reason) => failures.push(reason),
      onPublished: (repository, number) => published.push(`${repository}#${number}`),
      store: test.store,
      workerId: 'status-publisher-1',
    })

    await scheduler.runNow()

    expect(bodies).toEqual(['<!-- harlan-agent-kit:pr-triage -->\n### 🤖 READY · 96/100'])
    expect(labels).toEqual(['READY'])
    expect(failures).toEqual([])
    // The success signal an Incident raised here needs to be resolved by.
    expect(published).toEqual([`harlan-zw/example#${test.pullRequest.number}`])
    expect(test.store.claimNextTerminalReviewStatus('status-publisher-2', '2026-08-13T01:02:00.000Z', 60_000)).toBeNull()
    expect(test.store.listWorkflowEvents({ stream: 'review_status', limit: 20 }).map(event => event.event)).toContain('Published')
  })

  it('retries a terminal status failure without another Agent Task', async () => {
    const test = stagedTerminalStatus()
    let writes = 0
    const failures: string[] = []
    const published: string[] = []
    const scheduler = createReviewStatusScheduler({
      github: {
        readExistingReviewLabel: () => { throw new Error('Unexpected existing review.') },
        getPullRequestReviewSnapshot: () => Promise.resolve(ok(snapshot(test.pullRequest))),
        upsertReviewStatus: () => {
          writes += 1
          return Promise.resolve(writes === 1
            ? err('GitHub timed out.')
            : ok({ commentId: 42, url: `${test.pullRequest.url}#issuecomment-42` }))
        },
        stampAgentLabel: () => Promise.resolve(ok(undefined)),
      },
      intervalMilliseconds: 5_000,
      leaseMilliseconds: 60_000,
      now: () => new Date('2026-08-13T01:01:30.000Z'),
      onError: (error) => { throw error },
      onFailure: (_repository, _number, reason) => failures.push(reason),
      onPublished: (repository, number) => published.push(`${repository}#${number}`),
      store: test.store,
      workerId: 'status-publisher-1',
    })

    await scheduler.runNow()
    await scheduler.runNow()

    expect(writes).toBe(2)
    expect(failures).toEqual(['GitHub timed out.'])
  })

  it('retries a missing outcome label and records each confirmed sink', async () => {
    const test = stagedTerminalStatus()
    let labelWrites = 0
    const commentIds: Array<number | null> = []
    const scheduler = createReviewStatusScheduler({
      github: {
        readExistingReviewLabel: () => { throw new Error('Unexpected existing review.') },
        getPullRequestReviewSnapshot: () => Promise.resolve(ok(snapshot(test.pullRequest))),
        upsertReviewStatus: (_repository, _number, commentId) => {
          commentIds.push(commentId)
          return Promise.resolve(ok({ commentId: 42, url: `${test.pullRequest.url}#issuecomment-42` }))
        },
        stampAgentLabel: () => {
          labelWrites += 1
          return Promise.resolve(labelWrites === 1 ? err('GitHub refused the label.') : ok(undefined))
        },
      },
      intervalMilliseconds: 5_000,
      leaseMilliseconds: 60_000,
      now: () => new Date('2026-08-13T01:01:30.000Z'),
      onError: (error) => { throw error },
      onFailure: () => undefined,
      onPublished: () => undefined,
      store: test.store,
      workerId: 'status-publisher-1',
    })

    await scheduler.runNow()
    await scheduler.runNow()

    expect(labelWrites).toBe(2)
    expect(commentIds).toEqual([null, 42])
    expect(test.store.listWorkflowEvents({ stream: 'review_status', limit: 20 }).map(event => event.event)).toEqual(expect.arrayContaining([
      'CommentConfirmed',
      'OutcomeLabelConfirmed',
      'Published',
    ]))
  })
})
