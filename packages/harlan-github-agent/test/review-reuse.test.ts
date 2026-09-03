import type { PullRequestReviewSnapshot } from '../src/github-agent-source.ts'
import type { ReviewWorker } from '../src/item-agent.ts'
import type { ClaimedAdversarialReviewTask, GitHubPullRequestItem } from '../src/types.ts'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { err, ok } from '../src/result.ts'
import { createReviewReuseWorker, reviewReuseCandidate } from '../src/review-reuse.ts'
import { createReviewStatusController } from '../src/review-status-controller.ts'
import { openJournalStore } from '../src/store.ts'
import { createAgentWorkspaceManager } from '../src/worktree.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const temporaryDirectories: string[] = []
const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => {
  temporaryDirectories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
  stores.splice(0).forEach(store => store.close())
})

function git(checkout: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-C', checkout, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

/**
 * One pull request whose head moved twice: once by a merge of the base branch
 * that keeps the diff, once by a real change. The controller checkout is
 * cloned before either move, so the identity read has to fetch.
 */
function repository() {
  const directory = mkdtempSync(join(tmpdir(), 'harlan-review-reuse-'))
  temporaryDirectories.push(directory)
  const remote = join(directory, 'remote.git')
  const author = join(directory, 'author')
  const checkout = join(directory, 'checkout')
  const root = join(directory, 'controller')
  execFileSync('git', ['init', '--bare', '--quiet', remote])
  execFileSync('git', ['clone', '--quiet', remote, author], { stdio: 'ignore' })
  git(author, 'config', 'user.name', 'Test Author')
  git(author, 'config', 'user.email', 'author@example.com')
  git(author, 'checkout', '-b', 'main')
  writeFileSync(join(author, 'file.ts'), 'export const value = 1\n')
  writeFileSync(join(author, 'other.ts'), 'export const other = 1\n')
  git(author, 'add', '.')
  git(author, 'commit', '-m', 'initial')
  git(author, 'push', 'origin', 'main')
  const base1 = git(author, 'rev-parse', 'HEAD')
  git(author, 'checkout', '-b', 'fix/review')
  writeFileSync(join(author, 'file.ts'), 'export const value = 2\n')
  git(author, 'commit', '-am', 'change')
  const head1 = git(author, 'rev-parse', 'HEAD')
  git(author, 'push', 'origin', 'HEAD:refs/pull/24/head')
  execFileSync('git', ['clone', '--quiet', remote, checkout], { stdio: 'ignore' })
  git(checkout, 'fetch', 'origin', `+${head1}:refs/harlan-github-agent/reviews/24/head`)

  git(author, 'checkout', 'main')
  writeFileSync(join(author, 'other.ts'), 'export const other = 2\n')
  git(author, 'commit', '-am', 'base moves')
  git(author, 'push', 'origin', 'main')
  const base2 = git(author, 'rev-parse', 'HEAD')
  git(author, 'checkout', 'fix/review')
  git(author, 'merge', '--no-edit', 'main')
  const head2 = git(author, 'rev-parse', 'HEAD')
  git(author, 'push', 'origin', 'HEAD:refs/pull/24/head')
  writeFileSync(join(author, 'file.ts'), 'export const value = 3\n')
  git(author, 'commit', '-am', 'more change')
  const head3 = git(author, 'rev-parse', 'HEAD')
  git(author, 'push', 'origin', 'HEAD:refs/pull/24/head')

  return { remote, checkout, root, base1, base2, head1, head2, head3 }
}

const passed = { _tag: 'Passed' as const, evidence: [{ label: 'gate', sha256: 'b'.repeat(64) }] }
const check = { id: 1, failure: { _tag: 'NotAsked' as const }, source: { _tag: 'CheckRun' as const, appId: 15368 }, name: 'test', status: 'completed', conclusion: 'success' }

function snapshot(pullRequest: GitHubPullRequestItem): PullRequestReviewSnapshot {
  return {
    baseChecks: { _tag: 'Available', checks: [check] },
    body: '',
    checks: { _tag: 'Available', checks: [check] },
    comments: [],
    priorAutomatedReview: { _tag: 'None' },
    pullRequest,
    requiredChecks: { _tag: 'None' },
    reviews: [],
  } as PullRequestReviewSnapshot
}

/** A store holding one completed, published Review of the first head. */
function reviewedFirstHead(input: { checkout: string, base1: string, head1: string }) {
  const store = openJournalStore(':memory:')
  stores.push(store)
  const mapping = repositoryMapping({ checkout: input.checkout })
  store.syncRepositories([mapping], '2026-09-01T00:00:00.000Z')
  const first = pullRequestItem({ baseSha: input.base1, headSha: input.head1, headRef: 'fix/review', mergeState: 'clean' })
  const observed = store.recordObservation({ externalId: 'obs-1', observedAt: '2026-09-01T01:00:00.000Z', source: 'poll', subject: first })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected a pull request.')
  const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-09-01T01:01:00.000Z', 60_000)
  if (task === null)
    throw new Error('Expected a Review Task.')
  const recorded = store.recordReviewRun({
    id: 'run-1',
    repository: mapping.github,
    pullRequestNumber: 24,
    revisionId: observed.revisionId,
    headSha: input.head1,
    provider: 'codex',
    sessionId: 'session-1',
    model: 'gpt-5.6-sol',
    agentVersion: '0.0.0',
    skillDigest: 'a'.repeat(64),
    startedAt: '2026-09-01T01:01:00.000Z',
    completedAt: '2026-09-01T01:12:00.000Z',
    gates: { merge: passed, review: passed, ci: passed },
    confidence: 91,
    findings: [],
  })
  if (recorded._tag !== 'Inserted')
    throw new Error(`Expected the first Review to be stored: ${recorded._tag}`)
  store.recordReviewPublication({
    id: 'publication-1',
    reviewRunId: 'run-1',
    body: '### 🤖 READY · 91/100',
    at: '2026-09-01T01:12:30.000Z',
    result: { _tag: 'Published', githubCommentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' },
  })
  store.completeReviewTask({
    taskId: task.id,
    workerId: task.state.workerId,
    fence: task.state.fence,
    at: '2026-09-01T01:13:00.000Z',
    evidence: 'run-1',
    resolution: { _tag: 'Reviewed', reviewRunId: 'run-1' },
  })
  return { mapping, store }
}

function claimNewHead(store: ReturnType<typeof openJournalStore>, pullRequest: GitHubPullRequestItem): ClaimedAdversarialReviewTask {
  const observed = store.recordObservation({ externalId: 'obs-2', observedAt: '2026-09-01T02:00:00.000Z', source: 'poll', subject: pullRequest })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected a new pull request head.')
  const task = store.claimNextAdversarialReviewTask('reviewer-2', '2026-09-01T02:01:00.000Z', 60_000)
  if (task === null)
    throw new Error('Expected a Review Task for the new head.')
  return task
}

function harness(input: { remote: string, root: string, store: ReturnType<typeof openJournalStore>, live: GitHubPullRequestItem }) {
  const started: string[] = []
  const failures: string[] = []
  const inner: ReviewWorker = {
    run: (task) => {
      started.push(task.pullRequest.headSha)
      return Promise.resolve(err('A fresh Review started.'))
    },
  }
  const worker = createReviewReuseWorker({
    onReuseFailure: (_task, reason) => failures.push(reason),
    github: { getPullRequestReviewSnapshot: () => Promise.resolve(ok(snapshot(input.live))) },
    now: () => new Date('2026-09-01T02:01:30.000Z'),
    status: createReviewStatusController({
      github: {
        getPullRequestReviewSnapshot: () => Promise.reject(new Error('Staging reads nothing.')),
        stampAgentLabel: () => Promise.reject(new Error('Staging stamps nothing.')),
        upsertReviewStatus: () => Promise.reject(new Error('Staging writes nothing.')),
      },
      leaseMilliseconds: 60_000,
      now: () => new Date('2026-09-01T02:01:30.000Z'),
      store: input.store,
      workerId: 'status-1',
    }),
    store: input.store,
    workspaces: createAgentWorkspaceManager({
      remoteUrl: () => input.remote,
      root: input.root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-09-01T03:00:00.000Z' })), invalidate: () => undefined },
    }),
  }, inner)
  return { failures, started, worker }
}

describe('review reuse', () => {
  it('reuses the prior Review for a merge of the base branch that keeps the diff', async () => {
    const repo = repository()
    const { mapping, store } = reviewedFirstHead(repo)
    const merged = pullRequestItem({ baseSha: repo.base2, headSha: repo.head2, headRef: 'fix/review', mergeState: 'clean' })
    const task = claimNewHead(store, merged)
    const { failures, started, worker } = harness({ remote: repo.remote, root: repo.root, store, live: merged })

    const result = await worker.run(task, new AbortController().signal)

    expect(failures).toEqual([])
    expect(started).toEqual([])
    if (result._tag !== 'Ok')
      throw new Error(result.error)
    expect(result.value.resolution._tag).toBe('Reviewed')
    const reviewRunId = result.value.evidence
    // The reused row restates run-1, so the list counts the Agent turn once.
    const runs = store.listReviewRuns(mapping.github, 24)
    expect(runs.map(run => ({ id: run.id, headSha: run.headSha, outcome: run.outcome, findings: run.findings }))).toEqual([
      { id: reviewRunId, headSha: repo.head2, outcome: { _tag: 'Ready', confidence: 91 }, findings: [] },
    ])
    expect(store.listWorkflowEvents({ stream: 'review_run' }).map(event => [event.event, event.from, event.to, event.reason]))
      .toContainEqual(['Reused', repo.head1, repo.head2, expect.stringContaining(repo.head1.slice(0, 12))])

    expect(store.completeReviewTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-09-01T02:01:40.000Z',
      evidence: reviewRunId,
      resolution: result.value.resolution,
    })).toBe(true)
    const command = store.claimNextTerminalReviewStatus('publisher-1', '2026-09-01T02:01:50.000Z', 60_000)
    expect(command?.expectedHeadSha).toBe(repo.head2)
    expect(command?.body).toContain(`<!-- reviewed-sha: ${repo.head2} -->`)
    expect(command?.body).toContain('### 🤖 READY · 91/100')
    expect(command?.body).toContain(`Reused the Review of \`${repo.head1.slice(0, 12)}\``)
  })

  it('starts a fresh Review when the diff changed', async () => {
    const repo = repository()
    const { mapping, store } = reviewedFirstHead(repo)
    const changed = pullRequestItem({ baseSha: repo.base2, headSha: repo.head3, headRef: 'fix/review', mergeState: 'clean' })
    const task = claimNewHead(store, changed)
    const { started, worker } = harness({ remote: repo.remote, root: repo.root, store, live: changed })

    const result = await worker.run(task, new AbortController().signal)

    expect(result).toEqual(err('A fresh Review started.'))
    expect(started).toEqual([repo.head3])
    expect(store.listReviewRuns(mapping.github, 24).map(run => run.id)).toEqual(['run-1'])
  })

  it('starts a fresh Review when the manual Review label is on the new head', async () => {
    const repo = repository()
    const { store } = reviewedFirstHead(repo)
    const labelled = pullRequestItem({ approvalLabels: ['review'], baseSha: repo.base2, headSha: repo.head2, headRef: 'fix/review', mergeState: 'clean' })
    const task = claimNewHead(store, labelled)
    const { started, worker } = harness({ remote: repo.remote, root: repo.root, store, live: labelled })

    await worker.run(task, new AbortController().signal)

    expect(started).toEqual([repo.head2])
  })
})

describe('reviewReuseCandidate', () => {
  const prior = {
    reviewRunId: 'run-1',
    revisionId: 'revision-1',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    baseRef: 'main',
    gates: { merge: passed, review: passed, ci: passed },
    findings: [],
    confidence: 91,
    completedAt: '2026-09-01T01:12:00.000Z',
  }
  const pullRequest = { approvalLabels: [], baseRef: 'main', headSha: 'c'.repeat(40) }

  it.each([
    ['a base branch change', { prior: { ...prior, baseRef: 'release' }, pullRequest }],
    ['an open repairable finding', { prior: { ...prior, findings: [{ _tag: 'Open' as const, summary: 'Bug.', nextAction: 'Fix.', resolution: 'Repair' as const }] }, pullRequest }],
    ['the same head', { prior, pullRequest: { ...pullRequest, headSha: prior.headSha } }],
  ])('refuses %s', (_label, input) => {
    expect(reviewReuseCandidate(input)._tag).toBe('Fresh')
  })

  it('accepts a dismissal verdict, which needs no Repair', () => {
    const dismissal = { ...prior, findings: [{ _tag: 'Open' as const, summary: 'Wrong premise.', nextAction: 'Close.', resolution: 'Dismissal' as const }] }
    expect(reviewReuseCandidate({ prior: dismissal, pullRequest })).toEqual({ _tag: 'Candidate', prior: dismissal })
  })
})
