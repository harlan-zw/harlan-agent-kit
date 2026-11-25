import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { H3 } from 'h3'
import { expect, it } from 'vitest'
import { createAgentApp } from '../src/app.ts'
import { reconcileRepository } from '../src/reconcile.ts'
import { ok } from '../src/result.ts'
import { startAgentServer } from '../src/server.ts'
import { openJournalStore } from '../src/store.ts'
import { runCompletionTask } from '../src/take-ownership-completion.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

const at = (second: number) => new Date(Date.parse('2026-10-05T00:00:00Z') + second * 1000).toISOString()
const repository = repositoryMapping({ checkout: '/home/harlan/sites/example', takeOwnership: {
  _tag: 'Enabled',
  productionUrl: 'https://example.com',
  requiredWorkflows: ['deploy.yml'],
  smokePaths: ['/health'],
} })

function published(store: ReturnType<typeof openJournalStore>) {
  store.syncRepositories([repository], at(0))
  store.setRepositoryWritesEnabled(repository.github, true)
  store.recordPollObservation({ observedAt: at(1), subject: issueItem({ author: 'harlan-zw' }) })
  const triage = store.claimNextIssueTriageTask('triage', at(2), 600_000)!
  store.completeWorkerTask({ taskId: triage.id, workerId: 'triage', fence: triage.state.fence, at: at(3), evidence: JSON.stringify({ _tag: 'READY_TO_IMPLEMENT' }) })
  const task = store.claimNextIssueWorkTask('implementer', at(4), 600_000)!
  const staged = store.stagePublication({ taskId: task.id, workerId: 'implementer', fence: task.state.fence, at: at(5), publication: {
    _tag: 'OpenPullRequest',
    taskKind: 'issue_work',
    issueNumber: 12,
    pullRequestTitle: 'fix: repair the issue',
    pullRequestBody: 'Closes #12.',
    diagram: null,
    commitSha: 'h'.repeat(40),
    baseSha: 'b'.repeat(40),
    baseRef: 'main',
    expectedHeadSha: 'b'.repeat(40),
    headRef: 'fix/issue-12',
    artifactRef: 'refs/artifact',
    patchDigest: 'digest',
    changedFiles: 1,
  } })
  expect(staged._tag).toBe('Staged')
  const command = store.claimNextPublication('publisher', at(6), 600_000)!
  expect(store.completePublication({ commandId: command.id, workerId: 'publisher', fence: command.fence, at: at(7), evidence: 'Opened pull request #24.', pullRequestNumber: 24 })).toBe(true)
}

function merged(store: ReturnType<typeof openJournalStore>, number = 24) {
  const subject = pullRequestItem({ number, state: 'closed', mergedAt: at(8), updatedAt: at(8), headSha: 'h'.repeat(40), mergeCommitSha: 'm'.repeat(40) })
  const write = store.recordPollObservation({ observedAt: at(9), subject })
  if (write._tag !== 'Inserted' && write._tag !== 'Duplicate')
    throw new Error('The merge observation did not land.')
  return () => store.recordVerifiedPullRequestClosure({ repository: repository.github, pullRequestNumber: number, revisionId: write.revisionId, headSha: subject.headSha, baseSha: subject.baseSha, disposition: { _tag: 'Merged' }, at: at(10) })
}

it('queues only an exactly confirmed Service-created merge, once across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'completion-'))
  const path = join(directory, 'state.sqlite')
  let store = openJournalStore(path)
  try {
    published(store)
    const confirm = merged(store)
    expect(store.queueCompletionTasks(repository, at(11))).toBe(0)
    expect(confirm()).toBe(true)
    merged(store, 25)()
    expect(store.queueCompletionTasks(repository, at(12))).toBe(1)
    store.close()
    store = openJournalStore(path)
    expect(store.queueCompletionTasks(repository, at(13))).toBe(0)
    expect(store.getDashboardSnapshot(at(13)).completionTasks).toMatchObject([
      { repository: repository.github, target: { pullRequestNumber: 24, mergeSha: 'm'.repeat(40) }, state: { _tag: 'Queued' } },
    ])
  }
  finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('checks a manual merge after the submitting CLI exits and the Service restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'completion-handoff-'))
  const path = join(directory, 'state.sqlite')
  const passwordPath = join(directory, 'password')
  const checkout = join(directory, 'checkout')
  mkdirSync(checkout)
  const execute = promisify(execFile)
  const git = async (...args: string[]) => (await execute('git', ['-c', 'user.name=Completion Test', '-c', 'user.email=completion@example.test', ...args], { cwd: checkout })).stdout.trim()
  const password = 'local-test-password-with-at-least-32-bytes'
  writeFileSync(passwordPath, password, { mode: 0o600 })
  let store = openJournalStore(path)
  try {
    await git('init', '--initial-branch=main')
    await git('commit', '--allow-empty', '-m', 'chore: create base')
    const baseSha = await git('rev-parse', 'HEAD')
    await git('switch', '-c', 'feature')
    await git('commit', '--allow-empty', '-m', 'feat: open test pull request')
    const subject = pullRequestItem({ updatedAt: at(1), baseSha, headSha: await git('rev-parse', 'HEAD') })
    store.syncRepositories([repository], at(0))
    store.setRepositoryWritesEnabled(repository.github, true)
    store.recordPollObservation({ observedAt: at(1), subject })
    let app: ReturnType<typeof createAgentApp> | undefined
    const gateway = new H3()
    gateway.post('/api/tasks/register-completion', (event) => {
      if (app === undefined)
        throw new Error('The test service is not ready.')
      return app.fetch(event.req)
    })
    const server = await startAgentServer({ app: gateway, hostname: '127.0.0.1', port: 0 })
    try {
      if (server.url === undefined)
        throw new Error('The test server has no URL.')
      const url = server.url
      app = createAgentApp({ allowedOrigin: url, dashboardPassword: password, now: () => new Date(at(2)), store, registerCompletion: store.registerCompletion })
      const register = () => execute(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, '..', 'src', 'cli.ts'), 'control', 'register-completion', '--repository', repository.github, '--number', String(subject.number), '--url', url, '--password-file', passwordPath], { timeout: 10_000 })
      expect(JSON.parse((await register()).stdout)).toEqual({ _tag: 'Registered' })
      expect(JSON.parse((await register()).stdout)).toEqual({ _tag: 'Registered' })
    }
    finally { await server.close() }
    expect(store.queueCompletionTasks(repository, at(3))).toBe(0)

    // No client is connected when the exact GitHub read first reports the merge.
    store.close()
    store = openJournalStore(path)
    await git('commit', '--allow-empty', '-m', 'fix: update the test pull request')
    const mergedHead = await git('rev-parse', 'HEAD')
    await git('switch', 'main')
    await git('merge', '--no-ff', '-m', 'Merge the test pull request', 'feature')
    const mergeSha = await git('rev-parse', 'HEAD')
    const github = {
      listOpenItems: async () => ok([]),
      getIssue: async () => ok(issueItem()),
      getPullRequest: async () => ok({ ...subject, state: 'closed' as const, mergedAt: at(4), updatedAt: at(4), headSha: mergedHead, mergeCommitSha: mergeSha }),
    }
    expect((await reconcileRepository(repository, { github, store, now: () => new Date(at(5)) }))._tag).toBe('Ok')
    await runCompletionTask({ repository, store, now: () => new Date(at(6)), workerId: 'completion', source: {
      workflows: async () => ok([
        { id: 1, path: '.github/workflows/deploy.yml', source: { _tag: 'Push', sha: subject.headSha, branch: 'main' }, status: 'completed', conclusion: 'failure', url: 'https://github.com/run/1' },
        { id: 2, path: '.github/workflows/deploy.yml', source: { _tag: 'Push', sha: mergeSha, branch: 'main' }, status: 'completed', conclusion: 'success', url: 'https://github.com/run/2' },
      ]),
      smoke: async () => ok(200),
    } }, new AbortController().signal)
    expect(store.getDashboardSnapshot(at(7)).completionTasks).toMatchObject([
      { target: { headSha: mergedHead, mergeSha }, state: { _tag: 'Completed', evidence: {
        workflows: [{ name: 'deploy.yml', url: 'https://github.com/run/2' }],
        smoke: [{ url: 'https://example.com/health', status: 200 }],
      } } },
    ])
    expect(store.queueCompletionTasks(repository, at(8))).toBe(0)
  }
  finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 20_000)

it('drops registration when GitHub confirms an unmerged closure', async () => {
  const store = openJournalStore(':memory:')
  const subject = pullRequestItem({ updatedAt: at(1) })
  try {
    store.syncRepositories([repository], at(0))
    store.setRepositoryWritesEnabled(repository.github, true)
    store.recordPollObservation({ observedAt: at(1), subject })
    expect(store.registerCompletion({ repository: repository.github, number: subject.number })).toEqual({ _tag: 'Registered' })
    const github = {
      listOpenItems: async () => ok([]),
      getIssue: async () => ok(issueItem()),
      getPullRequest: async () => ok({ ...subject, state: 'closed' as const, updatedAt: at(3) }),
    }
    expect((await reconcileRepository(repository, { github, store, now: () => new Date(at(4)) }))._tag).toBe('Ok')
    expect(store.queueCompletionTasks(repository, at(5))).toBe(0)
    store.recordPollObservation({ observedAt: at(6), subject: { ...subject, updatedAt: at(6) } })
    expect(merged(store, subject.number)()).toBe(true)
    expect(store.queueCompletionTasks(repository, at(11))).toBe(0)
  }
  finally { store.close() }
})

it('only registers open pull requests targeting the default branch with Take Ownership enabled', () => {
  const store = openJournalStore(':memory:')
  const subject = pullRequestItem({ baseRef: 'release', updatedAt: at(1) })
  const target = { repository: repository.github, number: subject.number }
  try {
    store.syncRepositories([{ ...repository, takeOwnership: { _tag: 'Disabled' } }], at(0))
    store.setRepositoryWritesEnabled(repository.github, true)
    expect(store.registerCompletion(target)).toEqual({ _tag: 'NotEnabled' })
    store.syncRepositories([repository], at(1))
    expect(store.registerCompletion(target)).toEqual({ _tag: 'Unavailable' })
    store.recordPollObservation({ observedAt: at(2), subject })
    expect(store.registerCompletion(target)).toEqual({ _tag: 'Unavailable' })
    store.recordPollObservation({ observedAt: at(3), subject: { ...subject, baseRef: repository.defaultBranch, updatedAt: at(3) } })
    expect(store.registerCompletion(target)).toEqual({ _tag: 'Registered' })
  }
  finally { store.close() }
})

it('fences old claims and respects repository pause and policy revocation', () => {
  const store = openJournalStore(':memory:')
  try {
    published(store)
    merged(store)()
    store.queueCompletionTasks(repository, at(11))
    store.setRepositoryPaused(repository.github, true)
    expect(store.claimCompletionTask(repository.github, 'first', at(12))).toBeNull()
    store.setRepositoryPaused(repository.github, false)
    const first = store.claimCompletionTask(repository.github, 'first', at(13))!
    expect(store.claimCompletionTask(repository.github, 'second', at(14))).toBeNull()
    const second = store.claimCompletionTask(repository.github, 'second', at(104))!
    expect(store.settleCompletionTask(first, { _tag: 'Pending', reason: 'pending' }, at(105))).toBe(false)
    store.setRepositoryWritesEnabled(repository.github, false)
    expect(store.settleCompletionTask(second, { _tag: 'Completed', evidence: { mergeSha: first.target.mergeSha, workflows: [], smoke: [] } }, at(106))).toBe(false)
  }
  finally { store.close() }
})

it('resumes Pending delivery, then stores workflow and smoke evidence', async () => {
  const store = openJournalStore(':memory:')
  let seconds = 11
  let delivered = false
  let smokeRequests = 0
  try {
    published(store)
    merged(store)()
    const options = { repository, store, workerId: 'completion', now: () => new Date(at(seconds)), source: {
      workflows: async () => ok(delivered
        ? [{ id: 1, path: '.github/workflows/deploy.yml', source: { _tag: 'Push' as const, sha: 'm'.repeat(40), branch: 'main' }, status: 'completed', conclusion: 'success', url: 'https://github.com/run/1' }]
        : []),
      smoke: async () => {
        smokeRequests++
        return ok(200)
      },
    } }
    await runCompletionTask(options, new AbortController().signal)
    expect(store.listCompletionTasks()[0]).toMatchObject({ state: { _tag: 'Queued' } })
    seconds = 72
    delivered = true
    await runCompletionTask(options, new AbortController().signal)
    expect(store.listCompletionTasks()[0]).toMatchObject({ state: { _tag: 'Completed', evidence: { mergeSha: 'm'.repeat(40) } } })
    expect(smokeRequests).toBe(1)
    seconds = 140
    await runCompletionTask(options, new AbortController().signal)
    expect(smokeRequests).toBe(1)
  }
  finally { store.close() }
})

it('recovers a published pull request that merged before the first observation', async () => {
  const store = openJournalStore(':memory:')
  let reads = 0
  try {
    published(store)
    const github = {
      listOpenItems: async () => ok([]),
      getIssue: async () => ok(issueItem({ state: 'closed' })),
      getPullRequest: async () => {
        reads++
        return ok(pullRequestItem({ state: 'closed', mergedAt: at(8), updatedAt: at(8), mergeCommitSha: 'm'.repeat(40) }))
      },
    }
    expect((await reconcileRepository(repository, { github, store, now: () => new Date(at(11)) }))._tag).toBe('Ok')
    expect(store.queueCompletionTasks(repository, at(12))).toBe(1)
    await reconcileRepository(repository, { github, store, now: () => new Date(at(13)) })
    expect(reads).toBe(1)
  }
  finally { store.close() }
})

it('bounds Pending checks and retires a changed policy without repeating Completion', () => {
  const store = openJournalStore(':memory:')
  try {
    published(store)
    merged(store)()
    store.queueCompletionTasks(repository, at(11))
    const task = store.claimCompletionTask(repository.github, 'completion', at(86412))!
    expect(store.settleCompletionTask(task, { _tag: 'Pending', reason: 'No deploy run.' }, at(86413))).toBe(true)
    expect(store.listCompletionTasks()[0]?.state).toEqual({ _tag: 'ActionRequired', reason: 'Completion exceeded 24 hours. No deploy run.' })
    expect(store.claimCompletionTask(repository.github, 'completion', at(86500))).toBeNull()
  }
  finally { store.close() }
})

it('retires queued work when Take Ownership is disabled', () => {
  const store = openJournalStore(':memory:')
  try {
    published(store)
    merged(store)()
    store.queueCompletionTasks(repository, at(11))
    const disabled = { ...repository, takeOwnership: { _tag: 'Disabled' as const } }
    store.syncRepositories([disabled], at(12))
    expect(store.queueCompletionTasks(disabled, at(13))).toBe(0)
    expect(store.listCompletionTasks()[0]?.state).toEqual({ _tag: 'ActionRequired', reason: 'Take Ownership policy changed. Check delivery for this pull request.' })
    expect(store.claimCompletionTask(repository.github, 'completion', at(14))).toBeNull()
  }
  finally { store.close() }
})
