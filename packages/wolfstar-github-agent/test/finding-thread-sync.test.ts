import type { ReviewFinding } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createFindingThreadSyncController } from '../src/finding-thread-sync.ts'
import { err, ok } from '../src/result.ts'
import { createReviewFindingThreadsReport } from '../src/service.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
const directories: string[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})
const at = '2026-10-14T01:00:00.000Z'
const later = '2026-10-14T01:05:00.000Z'

function publishedReview(path = ':memory:', findings: ReviewFinding[] = []) {
  const store = openJournalStore(path, true)
  stores.push(store)
  const repository = repositoryMapping()
  const pull = pullRequestItem({ mergeState: 'clean' })
  store.syncRepositories([repository], at)
  store.setRepositoryWritesEnabled(repository.github, true)
  const observed = store.recordObservation({
    externalId: 'thread-retry',
    observedAt: at,
    source: 'poll',
    subject: pull,
  })
  if (observed._tag !== 'Inserted') throw new Error('Expected a new Revision.')
  const task = store.claimNextAdversarialReviewTask('reviewer', at, 60_000)!
  store.completeWorkerTask({
    taskId: task.id,
    workerId: task.state.workerId,
    fence: task.state.fence,
    at,
    evidence: 'run',
  })
  const gates = {
    merge: { _tag: 'Passed' as const, evidence: [] },
    review:
      findings.length > 0
        ? { _tag: 'Failed' as const, reason: 'Open finding.', evidence: [] }
        : { _tag: 'Passed' as const, evidence: [] },
    ci: { _tag: 'Passed' as const, evidence: [] },
  }
  store.recordReviewRun({
    id: 'run',
    repository: repository.github,
    pullRequestNumber: pull.number,
    revisionId: observed.revisionId,
    headSha: pull.headSha,
    provider: 'codex',
    sessionId: 'session',
    model: 'model',
    agentVersion: '1',
    skillDigest: 'a'.repeat(64),
    startedAt: at,
    completedAt: at,
    gates,
    confidence: 95,
    findings,
  })
  const staged = store.stageReviewGateStatus({
    reviewRunId: 'run',
    repository: repository.github,
    pullRequestNumber: pull.number,
    revisionId: observed.revisionId,
    expectedHeadSha: pull.headSha,
    gates,
    desiredOutcome: findings.length > 0 ? 'BLOCKED' : 'READY',
    body: findings.length > 0 ? '### 🤖 BLOCKED' : '### 🤖 READY',
    at,
  })
  if (staged._tag !== 'Staged') throw new Error('Expected a Publication.')
  const command = store.claimReviewStatus(staged.commandId, 'publisher', at, 60_000)!
  expect(
    store.completeReviewStatus({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at,
      commentId: 42,
      url: `${pull.url}#issuecomment-42`,
    }),
  ).toBe(true)
  return { store, repository, pull }
}

describe('finding thread sync Publication', () => {
  it.each(['live_head', 'write_control'] as const)('writes nothing when %s changes during retry', async (change) => {
    const { store, repository, pull } = publishedReview()
    const writes: string[] = []
    const controller = createFindingThreadSyncController({
      store,
      workerId: 'retry-controller',
      now: () => new Date(at),
      readPullRequest: async () =>
        ok({ ...pull, state: 'closed', mergedAt: at, headSha: change === 'live_head' ? 'other' : pull.headSha }),
      mirror: {
        report: createReviewFindingThreadsReport(store, () => new Date(at)),
        source: {
          listReviewFindingThreads: async () => {
            store.setRepositoryWritesEnabled(repository.github, false)
            return ok([{ threadId: 'obsolete', fingerprint: 'a'.repeat(64), resolved: false }])
          },
          postReviewFindingComment: async () => {
            throw new Error('Unexpected finding comment.')
          },
          resolveReviewFindingThread: async (_repository, id, _signal, authorize) => {
            const authority = authorize()
            if (authority._tag === 'Err') return authority
            writes.push(id)
            return ok(undefined)
          },
        },
      },
    })
    await controller.run(new AbortController().signal)
    expect(writes).toEqual([])
    expect(store.hasPendingReviewFindingThreadSync(repository.github)).toBe(change === 'write_control')
    expect(store.listIncidents()).toEqual([])
  })

  it('backs off after failure instead of retrying on the next poll', () => {
    const { store } = publishedReview()
    const command = store.claimReviewFindingThreadSync('publisher', at, 60_000)!
    store.deferReviewFindingThreadSync(command, at, 'GitHub timed out.')
    expect(store.claimReviewFindingThreadSync('early', '2026-10-14T01:00:01.000Z', 60_000)).toBeNull()
    expect(store.claimReviewFindingThreadSync('due', later, 60_000)).not.toBeNull()
  })

  it.each([false, true])('restores earlier merged findings only with a recorded failure: %s', (priorFailure) => {
    const directory = mkdtempSync(join(tmpdir(), 'finding-sync-migration-'))
    directories.push(directory)
    const path = join(directory, 'journal.sqlite')
    const { store, pull } = publishedReview(path, [
      {
        _tag: 'Open',
        summary: 'A finding.',
        nextAction: 'Repair it.',
        resolution: 'Repair',
        details: {
          fingerprint: 'a'.repeat(64),
          location: { path: 'a.ts', line: 1 },
          proof: 'Observed.',
          regressionTest: null,
        },
      },
    ])
    if (priorFailure) {
      store.recordIncident({
        scope: { _tag: 'Repository', repository: pull.repository },
        kind: 'github_access',
        severity: 'warning',
        operation: 'review_finding_threads',
        message: 'Resource not accessible by integration',
        recovery: { _tag: 'OnNextOperation' },
        at,
      })
    }
    store.recordObservation({
      externalId: 'legacy-merge',
      observedAt: later,
      source: 'poll',
      subject: { ...pull, state: 'closed', mergedAt: later },
    })
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const legacy = new DatabaseSync(path)
    legacy.exec('DROP TABLE finding_thread_syncs; PRAGMA user_version = 91;')
    legacy.close()
    const migrated = openJournalStore(path, true)
    stores.push(migrated)
    expect(migrated.restoreReviewFindingThreadSyncs(later)).toBe(priorFailure ? 1 : 0)
    expect(migrated.restoreReviewFindingThreadSyncs(later)).toBe(0)
    const restored = migrated.claimReviewFindingThreadSync('recovery', later, 60_000)
    if (priorFailure) expect(restored).toMatchObject({ reviewRunId: 'run', headSha: pull.headSha })
    else expect(restored).toBeNull()
  })

  it('retries a failed resolution after merge and clears its Incident after the receipt', async () => {
    const { store, repository, pull } = publishedReview()
    store.recordObservation({
      externalId: 'merged-controller',
      observedAt: at,
      source: 'poll',
      subject: { ...pull, state: 'closed', mergedAt: at },
    })
    let failed = true
    let clock = at
    const resolved: string[] = []
    const controller = createFindingThreadSyncController({
      store,
      workerId: 'retry-controller',
      now: () => new Date(clock),
      readPullRequest: async () => ok({ ...pull, state: 'closed', mergedAt: at }),
      mirror: {
        report: createReviewFindingThreadsReport(store, () => new Date(clock)),
        source: {
          listReviewFindingThreads: async () =>
            ok([{ threadId: 'obsolete', fingerprint: 'a'.repeat(64), resolved: false }]),
          postReviewFindingComment: async () => {
            throw new Error('Merged pull requests must not get new finding comments.')
          },
          resolveReviewFindingThread: async (_repository, id, _signal, authorize) => {
            const authority = authorize()
            if (authority._tag === 'Err') return authority
            if (failed) return err('GitHub timed out.')
            resolved.push(id)
            return ok(undefined)
          },
        },
      },
    })
    expect(await controller.run(new AbortController().signal)).toMatchObject([{ outcome: { _tag: 'Failed' } }])
    expect(store.listIncidents().filter((incident) => incident.operation === 'review_finding_threads')).toHaveLength(1)
    failed = false
    clock = later
    expect(await controller.run(new AbortController().signal)).toMatchObject([
      { outcome: { _tag: 'Written', resolved: 1 } },
    ])
    expect(resolved).toEqual(['obsolete'])
    expect(store.hasPendingReviewFindingThreadSync(repository.github)).toBe(false)
    expect(store.listIncidents().filter((incident) => incident.operation === 'review_finding_threads')).toEqual([])
    expect(await controller.run(new AbortController().signal)).toEqual([])
  })

  it('keeps a repository Incident while another sync still waits', () => {
    const { store, repository } = publishedReview()
    const report = createReviewFindingThreadsReport(store, () => new Date(at))
    report(repository.github, { _tag: 'Failed', message: 'GitHub timed out.' })
    report(repository.github, { _tag: 'Written', posted: 0, resolved: 0, outsideDiff: 0 })
    expect(store.listIncidents().filter((incident) => incident.operation === 'review_finding_threads')).toHaveLength(1)
  })

  it('retains a failed sync across restart and merge without another Review', () => {
    const directory = mkdtempSync(join(tmpdir(), 'finding-sync-'))
    directories.push(directory)
    const path = join(directory, 'journal.sqlite')
    const { store, pull } = publishedReview(path)
    const first = store.claimReviewFindingThreadSync('first', at, 60_000)!
    expect(first).toMatchObject({ reviewRunId: 'run', headSha: pull.headSha })
    expect(store.deferReviewFindingThreadSync(first, at, 'GitHub unavailable.')).toBe(true)
    store.recordObservation({
      externalId: 'merged',
      observedAt: later,
      source: 'poll',
      subject: { ...pull, state: 'closed', mergedAt: later },
    })
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = openJournalStore(path, true)
    stores.push(reopened)
    const retry = reopened.claimReviewFindingThreadSync('retry', later, 60_000)!
    expect(retry).toMatchObject({ reviewRunId: 'run', headSha: pull.headSha })
    expect(reopened.authorizeReviewFindingThreadSync(retry, later)).toBe(true)
    expect(reopened.completeReviewFindingThreadSync(retry, later)).toBe(true)
    expect(reopened.claimReviewFindingThreadSync('again', later, 60_000)).toBeNull()
  })

  it('fences an expired attempt after another controller reclaims it', () => {
    const { store } = publishedReview()
    const first = store.claimReviewFindingThreadSync('first', at, 1)!
    const second = store.claimReviewFindingThreadSync('second', later, 60_000)!
    expect(store.authorizeReviewFindingThreadSync(first, later)).toBe(false)
    expect(store.completeReviewFindingThreadSync(first, later)).toBe(false)
    expect(store.authorizeReviewFindingThreadSync(second, later)).toBe(true)
  })

  it.each(['pause', 'repository_pause', 'writes', 'dismiss', 'head', 'base', 'policy'] as const)(
    'refuses a write after %s changes',
    (change) => {
      const { store, repository, pull } = publishedReview()
      const command = store.claimReviewFindingThreadSync('publisher', at, 60_000)!
      if (change === 'pause') store.pauseAgents(at)
      if (change === 'repository_pause') store.setRepositoryPaused(repository.github, true)
      if (change === 'writes') store.setRepositoryWritesEnabled(repository.github, false)
      if (change === 'dismiss') store.dismissItem({ repository: repository.github, itemNumber: pull.number, at })
      if (change === 'policy') store.syncRepositories([{ ...repository, pullRequestReview: false }], at)
      if (change === 'head' || change === 'base') {
        store.recordObservation({
          externalId: change,
          observedAt: later,
          source: 'poll',
          subject: { ...pull, ...(change === 'head' ? { headSha: 'changed' } : { baseRef: 'other' }) },
        })
      }
      expect(store.authorizeReviewFindingThreadSync(command, change === 'head' || change === 'base' ? later : at)).toBe(
        false,
      )
    },
  )
})
