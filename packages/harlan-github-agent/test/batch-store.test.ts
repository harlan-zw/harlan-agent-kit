import type { GitHubIssuePublisher } from '../src/github.ts'
import { describe, expect, it } from 'vitest'
import { normalizeBatchPlan } from '../src/batch-store.ts'
import { candidateIssueCommands, createCandidateIssueController } from '../src/candidate-issue-controller.ts'
import { ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { issueItem, repositoryMapping } from './fixtures.ts'

const at = (minute: number): string => `2026-09-04T01:${String(minute).padStart(2, '0')}:00.000Z`
const routineId = 'harlan-zw/example:sentry-checkin'
const runId = `${routineId}:2026-09-04T01:00:00.000Z`

const publisher: GitHubIssuePublisher = {
  findOpenIssueByFingerprint: () => Promise.resolve(ok(null)),
  findRoutineTrackingIssue: () => Promise.resolve(ok(null)),
  findIssueCommentByMarker: () => Promise.resolve(ok(null)),
  createComment: async () => ok({ id: 1 }),
  createIssue: async (input) => {
    const number = Number(/#(\d+)/.exec(input.body)?.[1] ?? 0)
    return ok({ number, url: `https://github.com/harlan-zw/example/issues/${number}` })
  },
}

/** Two Routine-filed issues, both triaged Ready to implement, so two Issue work Tasks wait. */
async function seedReadyRoutineIssues(store: ReturnType<typeof openJournalStore>, numbers: readonly number[]): Promise<void> {
  store.syncRepositories([repositoryMapping()], at(0))
  store.setRepositoryWritesEnabled('harlan-zw/example', true)
  store.syncRoutines({
    repository: 'harlan-zw/example',
    specSha: 'abc123',
    entries: [{ name: 'sentry-checkin', crons: ['0 1 * * *'], timeZone: 'UTC', mode: 'propose', enabled: true }],
    at: at(0),
  })
  store.openRoutineRun({ routineId, scheduledFor: '2026-09-04T01:00:00.000Z', specSha: 'abc123', at: at(0) })
  store.recordCandidates({
    routineId,
    runId,
    candidates: numbers.map(number => ({
      fingerprint: `src/file-${number}.ts`,
      title: 'Fixture title',
      target: `src/file-${number}.ts`,
      // The stub publisher reads the issue number it should answer from the claim.
      claim: `Issue #${number} needs a fix.`,
      verification: 'pnpm test',
      estimatedChangedFiles: 1,
    })),
    at: at(1),
  })
  const run = store.claimNextRoutineRun('routine-worker', at(1), 600_000)
  if (run === null)
    throw new Error('Expected a Routine run.')
  store.stageCandidateIssues({ commands: candidateIssueCommands(store.listCandidates(routineId), run), at: at(2) })
  await createCandidateIssueController({ github: publisher, now: () => new Date(at(2)), store, workerId: 'controller' }).publishPending(new AbortController().signal)

  for (const number of numbers) {
    store.recordObservation({
      externalId: `issue-${number}`,
      observedAt: at(3),
      source: 'poll',
      subject: issueItem({ number, author: 'harlan-zw', routineFiled: true, title: `Fix file ${number}`, url: `https://github.com/harlan-zw/example/issues/${number}` }),
    })
  }
  for (const number of numbers) {
    const triage = store.claimNextIssueTriageTask('triage-worker', at(4), 600_000)
    if (triage === null)
      throw new Error(`Expected an Issue triage Task for #${number}.`)
    store.completeWorkerTask({
      taskId: triage.id,
      workerId: 'triage-worker',
      fence: triage.state.fence,
      at: at(5),
      evidence: JSON.stringify({ _tag: 'READY_TO_IMPLEMENT', difficulty: 1, impact: 3, hasReproduction: true, needsCodebaseReview: false, summary: `Summary ${triage.issueNumber}`, nextAction: 'Fix it', relatedIssues: numbers.filter(other => other !== triage.issueNumber) }),
    })
  }
}

describe('normalizeBatchPlan', () => {
  it('appends every reserved issue the plan forgot as its own unit', () => {
    expect(normalizeBatchPlan([{ issueNumbers: [101, 102], dependsOn: null, rationale: 'Same cause.' }], [101, 102, 103])).toEqual(ok([
      { issueNumbers: [101, 102], dependsOn: null, rationale: 'Same cause.' },
      { issueNumbers: [103], dependsOn: null, rationale: 'The plan did not place this issue, so it runs alone.' },
    ]))
  })

  it('refuses an issue the Batch did not reserve, a repeated issue, and a forward stack', () => {
    expect(normalizeBatchPlan([{ issueNumbers: [999], dependsOn: null, rationale: '' }], [101])).toEqual({ _tag: 'Err', error: 'Unit 0 names issue #999, which this Batch did not reserve.' })
    expect(normalizeBatchPlan([
      { issueNumbers: [101], dependsOn: null, rationale: '' },
      { issueNumbers: [101], dependsOn: null, rationale: '' },
    ], [101])).toEqual({ _tag: 'Err', error: 'Issue #101 appears in two units.' })
    expect(normalizeBatchPlan([{ issueNumbers: [101], dependsOn: 1, rationale: '' }, { issueNumbers: [102], dependsOn: null, rationale: '' }], [101, 102]))
      .toEqual({ _tag: 'Err', error: 'Unit 0 stacks on unit 1, which is not an earlier unit.' })
  })
})

describe('batches in the journal', () => {
  it('reserves Ready Routine-filed issues, keeps plain Issue work off them, and runs units under one Batch lease', async () => {
    const store = openJournalStore(':memory:', true)
    try {
      await seedReadyRoutineIssues(store, [101, 102, 103])

      expect(store.planBatches(at(6))).toEqual([{ batchId: expect.any(String), repository: 'harlan-zw/example', issueNumbers: [101, 102, 103] }])
      // A second pass opens nothing while the Batch is open.
      expect(store.planBatches(at(7))).toEqual([])
      // Plain Issue work never touches a reserved Task.
      expect(store.claimNextIssueWorkTask('issue-worker', at(7), 600_000)).toBeNull()
      const queue = store.getDashboardSnapshot(at(7)).queue
      expect(queue.find(entry => entry.number === 101)?.state).toEqual({ _tag: 'Pending', reason: 'Planned in a Batch with #102, #103.' })

      const batch = store.claimNextBatch('batch-worker', at(8), 600_000)
      if (batch === null)
        throw new Error('Expected a Batch.')
      expect(batch.units).toBeNull()
      expect(batch.issues.map(issue => [issue.issueNumber, issue.target, issue.relatedIssues])).toEqual([
        [101, 'src/file-101.ts', [102, 103]],
        [102, 'src/file-102.ts', [101, 103]],
        [103, 'src/file-103.ts', [101, 102]],
      ])
      expect(store.claimNextBatch('other-worker', at(8), 600_000)).toBeNull()

      const planned = store.recordBatchPlan({
        batchId: batch.id,
        workerId: 'batch-worker',
        fence: batch.state.fence,
        at: at(9),
        units: [
          { issueNumbers: [101, 102], dependsOn: null, rationale: 'One change fixes both.' },
          { issueNumbers: [103], dependsOn: 0, rationale: 'Builds on the shared helper.' },
        ],
      })
      if (planned._tag === 'Err')
        throw new Error(planned.error)
      const [first, second] = planned.value
      if (first === undefined || second === undefined)
        throw new Error('Expected two units.')
      expect(second.dependsOnUnitId).toBe(first.id)
      expect(store.getBatchDependency(first.id)).toEqual({ _tag: 'Pending' })

      const task = store.claimBatchUnitTask({ unitId: first.id, workerId: 'batch-worker', now: at(10), leaseMilliseconds: 600_000 })
      if (task === null)
        throw new Error('Expected the unit Task.')
      expect(task.issueNumber).toBe(101)
      // The same unit cannot be claimed twice.
      expect(store.claimBatchUnitTask({ unitId: first.id, workerId: 'batch-worker', now: at(10), leaseMilliseconds: 600_000 })).toBeNull()

      const staged = store.stagePublication({
        taskId: task.id,
        workerId: 'batch-worker',
        fence: task.state.fence,
        at: at(11),
        publication: {
          _tag: 'OpenPullRequest',
          taskKind: 'issue_work',
          issueNumber: 101,
          pullRequestTitle: 'fix: shared helper',
          pullRequestBody: 'Closes #101.\nCloses #102.',
          commitSha: 'commit-1',
          baseSha: 'base-1',
          baseRef: 'main',
          expectedHeadSha: 'base-1',
          headRef: 'fix/issue-101',
          artifactRef: 'refs/artifact-1',
          patchDigest: 'digest-1',
          changedFiles: 2,
        },
      })
      expect(staged._tag).toBe('Staged')
      const combinedTaskId = batch.issues.find(issue => issue.issueNumber === 102)?.taskId
      if (combinedTaskId === undefined)
        throw new Error('Expected the combined Task.')
      expect(store.completeCombinedIssueWork({ taskId: combinedTaskId, at: at(11), evidence: 'Closed by #101.' })).toBe(true)

      const command = store.claimNextPublication('publisher', at(12), 600_000)
      if (command === null)
        throw new Error('Expected a publication command.')
      expect(store.completePublication({ commandId: command.id, workerId: 'publisher', fence: command.fence, at: at(13), evidence: 'Opened pull request #7.', pullRequestNumber: 7 })).toBe(true)
      expect(store.getBatchDependency(first.id)).toEqual({ _tag: 'Published', pullRequestNumber: 7, headRef: 'fix/issue-101', headSha: 'commit-1' })
      expect(store.settleBatchUnit({ unitId: first.id, at: at(13), state: { _tag: 'Published', pullRequestNumber: 7, headRef: 'fix/issue-101', headSha: 'commit-1' } })).toBe(true)

      expect(store.completeBatch({ batchId: batch.id, workerId: 'batch-worker', fence: batch.state.fence, at: at(14) })).toBe(true)
      // The unit the Batch never ran goes back to plain Issue work.
      expect(store.claimNextIssueWorkTask('issue-worker', at(15), 600_000)).toEqual(expect.objectContaining({ issueNumber: 103 }))
      expect(store.listBatches()[0]).toEqual(expect.objectContaining({ id: batch.id, state: { _tag: 'Completed' } }))
    }
    finally {
      store.close()
    }
  })

  it('opens no Batch for one issue or for a human issue', async () => {
    const store = openJournalStore(':memory:', true)
    try {
      await seedReadyRoutineIssues(store, [101])
      expect(store.planBatches(at(6))).toEqual([])
    }
    finally {
      store.close()
    }
  })
})
