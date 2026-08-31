import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const directories: string[] = []

afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { force: true, recursive: true })))

describe('explicit Review resolution', () => {
  it('completes locally before its terminal Publication and resumes after restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'harlan-review-resolution-'))
    directories.push(directory)
    const path = join(directory, 'journal.sqlite')
    const store = openJournalStore(path, true)
    const repository = repositoryMapping()
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    store.syncRepositories([repository], '2026-08-13T01:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'review-resolution',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequest,
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new Review Revision.')
    const task = store.claimNextAdversarialReviewTask('reviewer', '2026-08-13T01:00:01.000Z', 60_000)
    if (task === null)
      throw new Error('Expected a Review Task.')
    const staged = store.stageReviewStatus({
      taskKind: 'adversarial_review',
      phase: 'terminal',
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:00:02.000Z',
      revisionId: task.revisionId,
      expectedHeadSha: pullRequest.headSha,
      body: '<!-- harlan-agent-kit:pr-triage -->\n### 🤖 READY',
      desiredOutcome: 'READY',
    })
    expect(staged._tag).toBe('Staged')
    expect(store.completeReviewTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:00:03.000Z',
      evidence: 'Existing Review.',
      resolution: { _tag: 'ExistingReview', url: `${pullRequest.url}#issuecomment-42` },
    })).toBe(true)
    expect(store.getDashboardSnapshot('2026-08-13T01:00:04.000Z').queue).toEqual([])
    expect(store.listWorkflowEvents({ stream: 'review_resolution', limit: 10 })).toMatchObject([{
      event: 'Recorded',
      taskId: task.id,
      to: 'ExistingReview',
    }])
    store.close()

    const restarted = openJournalStore(path, true)
    const command = restarted.claimNextTerminalReviewStatus('publisher', '2026-08-13T01:00:05.000Z', 60_000)
    expect(command?.id).toBe(staged._tag === 'Rejected' ? '' : staged.commandId)
    if (command === null)
      throw new Error('Expected terminal Publication recovery.')
    expect(restarted.completeReviewStatus({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at: '2026-08-13T01:00:06.000Z',
      commentId: 42,
      url: `${pullRequest.url}#issuecomment-42`,
    })).toBe(true)
    restarted.close()
  })

  it('rejects a stale Review completion without recording a resolution', () => {
    const store = openJournalStore(':memory:', true)
    store.syncRepositories([repositoryMapping()], '2026-08-13T01:00:00.000Z')
    store.recordObservation({
      externalId: 'stale-review-resolution',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    const task = store.claimNextAdversarialReviewTask('reviewer', '2026-08-13T01:00:01.000Z', 60_000)
    if (task === null)
      throw new Error('Expected a Review Task.')
    expect(store.completeReviewTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence + 1,
      at: '2026-08-13T01:00:02.000Z',
      evidence: 'Stale.',
      resolution: { _tag: 'ReviewSkipped', reason: 'Stale test.' },
    })).toBe(false)
    expect(store.listWorkflowEvents({ stream: 'review_resolution', limit: 10 })).toEqual([])
    store.close()
  })
})
