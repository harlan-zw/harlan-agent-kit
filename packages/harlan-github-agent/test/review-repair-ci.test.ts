import type { PullRequestReviewSnapshot } from '../src/github-agent-source.ts'
import type { JournalStore } from '../src/store.ts'
import type { ReviewFinding, ReviewGates } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { terminalComment } from '../src/item-agent.ts'
import { ok } from '../src/result.ts'
import { refreshReviewGates } from '../src/review-gate-sweep.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()))

const finding: ReviewFinding = {
  _tag: 'Open',
  resolution: 'Repair',
  summary: 'A saved name shows a false error.',
  nextAction: 'Handle the later refresh separately.',
}

function setup(findings: ReviewFinding[] = [finding]) {
  const directory = mkdtempSync(join(tmpdir(), 'review-repair-ci-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'journal.sqlite')
  const mapping = repositoryMapping()
  const pullRequest = pullRequestItem({ mergeState: 'clean' })
  const store = openJournalStore(path, true)
  store.syncRepositories([mapping], '2026-09-08T04:00:00.000Z')
  store.setRepositoryWritesEnabled(mapping.github, true)
  const observed = store.recordObservation({
    externalId: 'pending-repair',
    observedAt: '2026-09-08T04:00:00.000Z',
    source: 'poll',
    subject: pullRequest,
  })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected the pull request.')
  const task = store.claimNextAdversarialReviewTask('reviewer', '2026-09-08T04:00:01.000Z', 60_000)
  if (task === null)
    throw new Error('Expected Review.')
  const gates: ReviewGates = {
    merge: { _tag: 'Passed', evidence: [] },
    review: { _tag: 'Failed', reason: finding.summary, evidence: [] },
    ci: { _tag: 'Pending', reason: 'Base branch CI: code is still running.', evidence: [] },
  }
  store.recordReviewRun({
    id: 'review-run',
    repository: mapping.github,
    pullRequestNumber: pullRequest.number,
    revisionId: observed.revisionId,
    headSha: pullRequest.headSha,
    provider: 'codex',
    sessionId: 'review-session',
    model: 'gpt-5.6-sol',
    agentVersion: '0.0.0',
    skillDigest: 'a'.repeat(64),
    startedAt: '2026-09-08T04:00:01.000Z',
    completedAt: '2026-09-08T04:00:02.000Z',
    gates,
    findings,
  })
  store.completeReviewTask({
    taskId: task.id,
    workerId: task.state.workerId,
    fence: task.state.fence,
    at: '2026-09-08T04:00:03.000Z',
    evidence: 'review-run',
    resolution: { _tag: 'Reviewed', reviewRunId: 'review-run' },
  })
  store.recordReviewPublication({
    id: 'review-publication',
    reviewRunId: 'review-run',
    at: '2026-09-08T04:00:04.000Z',
    body: terminalComment(pullRequest.headSha, pullRequest.baseSha, gates, findings, undefined, []),
    result: { _tag: 'Published', githubCommentId: 42, url: `${pullRequest.url}#issuecomment-42` },
  })
  store.close()
  const restarted = openJournalStore(path, true)
  cleanups.push(() => restarted.close())
  const check = { id: 1, name: 'code', status: 'completed', conclusion: 'success', source: { _tag: 'CheckRun' as const, appId: 1 }, failure: { _tag: 'NotAsked' as const } }
  const live: PullRequestReviewSnapshot = {
    pullRequest,
    baseChecks: { _tag: 'Available', checks: [check] },
    checks: { _tag: 'Available', checks: [check] },
    body: '',
    comments: [],
    reviews: [],
    requiredChecks: { _tag: 'None' },
    priorAutomatedReview: { _tag: 'None' },
  }
  const sweep = (at = '2026-09-08T04:10:00.000Z', beforeRepair = () => {}) => refreshReviewGates({
    store: restarted,
    repositories: [mapping],
    now: () => new Date(at),
    preflightRepair: () => {
      beforeRepair()
      return Promise.resolve(ok(undefined))
    },
    github: {
      getPullRequestReviewSnapshot: () => Promise.resolve(ok(live)),
      editReviewStatus: () => Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: pullRequest.url })),
      stampAgentLabel: () => Promise.resolve(ok(undefined)),
    },
  }, new AbortController().signal)
  return { store: restarted, sweep, live, mapping, task }
}

function publishStatus(store: JournalStore, minute = '10') {
  const command = store.claimNextTerminalReviewStatus('publisher', `2026-09-08T04:${minute}:01.000Z`, 60_000)
  if (command === null)
    throw new Error('Expected the updated Review status.')
  expect(store.completeReviewStatus({
    commandId: command.id,
    workerId: command.workerId,
    fence: command.fence,
    at: `2026-09-08T04:${minute}:02.000Z`,
    commentId: 42,
    url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
  })).toBe(true)
  return command
}

describe('repair after base CI', () => {
  it('recovers a completed BLOCKED Review after restart and queues its exact findings once', async () => {
    const { store, sweep } = setup()

    await sweep()
    const command = publishStatus(store)
    await sweep()
    const repair = store.claimNextReviewFixTask('repair', '2026-09-08T04:10:03.000Z', 60_000)

    expect(command.body).toContain('Repair round 1 of 3 starts.')
    expect(repair?.kind).toBe('review_fix')
    expect(store.getReviewFixFindings('harlan-zw/example', 24, repair!.revisionId)).toEqual([finding])
    expect(store.claimNextReviewFixTask('another-repair', '2026-09-08T04:10:04.000Z', 60_000)).toBeNull()
  })

  it('keeps Repair pending until the base CI passes', async () => {
    const { store, sweep, live } = setup()
    const passing = live.baseChecks
    live.baseChecks = { _tag: 'Unavailable', reason: 'GitHub timed out.' }

    await sweep()
    expect(store.claimNextReviewFixTask('repair', '2026-09-08T04:10:00.000Z', 60_000)).toBeNull()
    publishStatus(store)
    live.baseChecks = passing
    await sweep('2026-09-08T04:11:00.000Z')
    publishStatus(store, '11')

    expect(store.claimNextReviewFixTask('repair', '2026-09-08T04:11:03.000Z', 60_000)?.kind).toBe('review_fix')
  })

  it.each(['dismissed', 'manual', 'paused', 'writes-disabled', 'new-head', 'new-base'] as const)(
    'does not queue Repair when %s changes during the GitHub read',
    async (change) => {
      const { store, sweep, mapping, live } = setup()
      await sweep(undefined, () => {
        if (change === 'dismissed') {
          store.dismissItem({ repository: mapping.github, itemNumber: 24, at: '2026-09-08T04:09:00.000Z' })
        }
        else if (change === 'manual') {
          store.setSelectionMode('manual')
        }
        else if (change === 'paused') {
          store.setRepositoryPaused(mapping.github, true)
        }
        else if (change === 'writes-disabled') {
          store.setRepositoryWritesEnabled(mapping.github, false)
        }
        else {
          store.recordObservation({
            externalId: change,
            observedAt: '2026-09-08T04:09:00.000Z',
            source: 'poll',
            subject: { ...live.pullRequest, ...(change === 'new-head' ? { headSha: 'new-head' } : { baseSha: 'new-base' }) },
          })
        }
      })

      expect(store.getDashboardSnapshot('2026-09-08T04:10:01.000Z').tasks.filter(task => task.kind === 'review_fix')).toEqual([])
    },
  )

  it.each(['conflicting', 'unknown'] as const)('does not queue Repair while live mergeability is %s', async (mergeState) => {
    const { store, sweep, live } = setup()
    live.pullRequest = { ...live.pullRequest, mergeState }

    await sweep()

    expect(store.getDashboardSnapshot('2026-09-08T04:10:01.000Z').tasks.filter(task => task.kind === 'review_fix')).toEqual([])
  })

  it('does not repair a Review that recommends Dismissal', async () => {
    const { store, sweep } = setup([{ ...finding, resolution: 'Dismissal' }])

    await sweep()

    expect(store.getDashboardSnapshot('2026-09-08T04:10:01.000Z').tasks.filter(task => task.kind === 'review_fix')).toEqual([])
  })

  it.each(['cancelled', 'action-required'] as const)('does not restart a %s Repair after the base moves', async (stop) => {
    const { store, sweep, live } = setup()
    await sweep()
    publishStatus(store)
    const repair = store.claimNextReviewFixTask('repair', '2026-09-08T04:10:03.000Z', 60_000)
    if (repair === null)
      throw new Error('Expected Repair.')
    if (stop === 'cancelled') {
      expect(store.cancelTask({ taskId: repair.id, at: '2026-09-08T04:10:04.000Z' })._tag).toBe('Cancelled')
    }
    else {
      expect(store.needsAttentionTask({
        taskId: repair.id,
        workerId: repair.state.workerId,
        fence: repair.state.fence,
        at: '2026-09-08T04:10:04.000Z',
        reason: 'The Repair needs a decision.',
        evidence: 'blocked',
      })).toBe(true)
    }
    live.pullRequest = { ...live.pullRequest, baseSha: 'new-base' }
    store.recordObservation({ externalId: 'base-moved', observedAt: '2026-09-08T04:11:00.000Z', source: 'poll', subject: live.pullRequest })

    await sweep('2026-09-08T04:12:00.000Z')

    expect(store.claimNextReviewFixTask('another-repair', '2026-09-08T04:12:01.000Z', 60_000)).toBeNull()
  })

  it('recovers the same reviewed head after its base moves', async () => {
    const { store, sweep, live } = setup()
    live.pullRequest = { ...live.pullRequest, baseSha: 'new-base' }
    store.recordObservation({ externalId: 'base-moved', observedAt: '2026-09-08T04:09:00.000Z', source: 'poll', subject: live.pullRequest })

    await sweep()
    publishStatus(store)

    expect(store.claimNextReviewFixTask('repair', '2026-09-08T04:10:03.000Z', 60_000)?.pullRequest).toMatchObject({
      headSha: live.pullRequest.headSha,
      baseSha: 'new-base',
    })
  })
})
