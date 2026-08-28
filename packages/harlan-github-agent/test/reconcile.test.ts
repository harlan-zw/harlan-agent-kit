import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { reconcileRepository } from '../src/reconcile.ts'
import { err, ok } from '../src/result.ts'
import { AGENT_ACTOR_LOGIN } from '../src/review-comment.ts'
import { openJournalStore } from '../src/store.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

describe('gitHub reconciliation', () => {
  it('ignores issues authored by automated accounts', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')

    const result = await reconcileRepository(repository, {
      github: { listOpenItems: () => Promise.resolve(ok([issueItem({ author: 'github-actions[bot]' })])) },
      store,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    })

    expect(result).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 0, inserted: 0, duplicates: 0, stale: 0, closed: 0 },
    })
    expect(store.getDashboardSnapshot('2026-08-13T01:00:00.000Z').items).toEqual([])
    store.close()
  })

  it('closes an allowed bot issue and clears its failed triage incident', async () => {
    const store = openJournalStore(':memory:')
    const botIssue = issueItem({ author: AGENT_ACTOR_LOGIN })
    const repository = repositoryMapping({ writablePullRequestAuthors: ['harlan-zw', AGENT_ACTOR_LOGIN] })
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'allowed-bot-issue',
      observedAt: '2026-08-13T00:01:00.000Z',
      source: 'poll',
      subject: botIssue,
    })

    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-13T00:01:0${attempt}.000Z`
      const task = store.claimNextIssueTriageTask(`worker-${attempt}`, at, 10_000)
      if (task === null)
        throw new Error(`Expected Issue triage attempt ${attempt}.`)
      store.failWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason: 'The issue changed before triage started.',
      })
    }
    expect(store.listIncidents()).toHaveLength(1)

    const result = await reconcileRepository(repository, {
      github: { listOpenItems: () => Promise.resolve(ok([botIssue])) },
      store,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    })

    expect(result).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 0, inserted: 0, duplicates: 0, stale: 0, closed: 1 },
    })
    expect(store.resolveStaleTaskIncidents('2026-08-13T01:00:01.000Z')).toBe(1)
    expect(store.listIncidents()).toEqual([])
    store.close()
  })

  it('records our own Routine issue even when the allowlist lists only humans', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')

    const result = await reconcileRepository(repository, {
      github: { listOpenItems: () => Promise.resolve(ok([
        issueItem({ number: 41, author: AGENT_ACTOR_LOGIN, routineFiled: true, url: 'https://github.com/harlan-zw/example/issues/41' }),
      ])) },
      store,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    })

    expect(result).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 1, inserted: 1, duplicates: 0, stale: 0, closed: 0 },
    })
    store.close()
  })

  it('counts only open pull requests in enabled repositories', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    expect(store.countOpenPullRequests()).toBe(0)

    const github = {
      listOpenItems: () => Promise.resolve(ok([
        pullRequestItem({ number: 24 }),
        pullRequestItem({ number: 25 }),
        issueItem({ number: 12, author: 'harlan-zw' }),
      ])),
    }
    await reconcileRepository(repository, { github, store, now: () => new Date('2026-08-13T01:00:00.000Z') })
    expect(store.countOpenPullRequests()).toBe(2)

    // A pull request that disappears from the open list closes, so it stops counting.
    await reconcileRepository(repository, {
      github: { listOpenItems: () => Promise.resolve(ok([pullRequestItem({ number: 24 })])) },
      store,
      now: () => new Date('2026-08-13T02:00:00.000Z'),
    })
    expect(store.countOpenPullRequests()).toBe(1)

    store.syncRepositories([{ ...repository, enabled: false }], '2026-08-13T03:00:00.000Z')
    expect(store.countOpenPullRequests()).toBe(0)
    store.close()
  })

  it('records a pull request from an explicitly allowed GitHub App', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping({ writablePullRequestAuthors: ['harlan-zw', 'harlan-github-agent[bot]'] })
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')

    const result = await reconcileRepository(repository, {
      github: { listOpenItems: () => Promise.resolve(ok([pullRequestItem({ author: 'harlan-github-agent[bot]' })])) },
      store,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    })

    expect(result).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 1, inserted: 1, duplicates: 0, stale: 0, closed: 0 },
    })
    store.close()
  })

  it('records subjects idempotently and updates poll health', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    const github = { listOpenItems: () => Promise.resolve(ok([issueItem()])) }
    const now = () => new Date('2026-08-13T01:00:00.000Z')

    const first = await reconcileRepository(repository, { github, store, now })
    const second = await reconcileRepository(repository, { github, store, now })

    expect(first).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 1, inserted: 1, duplicates: 0, stale: 0, closed: 0 },
    })
    expect(second).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 1, inserted: 0, duplicates: 1, stale: 0, closed: 0 },
    })
    expect(store.getDashboardSnapshot(now().toISOString()).repositories[0]?.lastError).toBeNull()
    store.close()
  })

  it('reconciles Approval labels for issues', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    const issue = issueItem({ approvalLabels: ['review'] })
    const approved: Array<{ kind: string, revisionId: string }> = []
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')

    const result = await reconcileRepository(repository, {
      approvals: {
        reconcile: (_mapping, subject, revisionId) => {
          approved.push({ kind: subject.kind, revisionId })
          return Promise.resolve(ok(undefined))
        },
      },
      github: { listOpenItems: () => Promise.resolve(ok([issue])) },
      store,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    })

    expect(result._tag).toBe('Ok')
    expect(approved).toEqual([{ kind: 'issue', revisionId: expect.stringMatching(/^[a-f\d]{64}$/) }])
    store.close()
  })

  it('surfaces GitHub failures in repository health', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    const github = { listOpenItems: () => Promise.resolve(err({ repository: repository.github, message: 'Rate limited' })) }
    const now = () => new Date('2026-08-13T01:00:00.000Z')

    const result = await reconcileRepository(repository, { github, store, now })

    expect(result).toEqual({ _tag: 'Err', error: { repository: repository.github, message: 'Rate limited' } })
    expect(store.getDashboardSnapshot(now().toISOString()).repositories[0]?.lastError).toBe('Rate limited')
    store.close()
  })

  it('does not report shutdown cancellation as repository failure', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    const controller = new AbortController()
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    controller.abort()

    const result = await reconcileRepository(repository, {
      github: { listOpenItems: () => Promise.resolve(err({ repository: repository.github, message: 'This operation was aborted' })) },
      store,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      signal: controller.signal,
    })

    expect(result).toEqual({ _tag: 'Err', error: { repository: repository.github, message: 'This operation was aborted' } })
    expect(store.getDashboardSnapshot('2026-08-13T01:00:00.000Z').repositories[0]?.lastError).toBeNull()
    expect(store.listIncidents()).toEqual([])
    store.close()
  })

  it('does not reuse legacy observation identities after revision schema changes', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    const incoming = issueItem()
    const legacyExternalId = createHash('sha256')
      .update(`${repository.github}:${incoming.kind}:${incoming.number}:${JSON.stringify(incoming)}`)
      .digest('hex')
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: legacyExternalId,
      observedAt: '2026-08-13T00:30:00.000Z',
      source: 'poll',
      subject: issueItem({ title: 'Legacy snapshot' }),
    })

    const result = await reconcileRepository(repository, {
      github: { listOpenItems: () => Promise.resolve(ok([incoming])) },
      store,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    })

    expect(result).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 1, inserted: 1, duplicates: 0, stale: 0, closed: 0 },
    })
    store.close()
  })
})
