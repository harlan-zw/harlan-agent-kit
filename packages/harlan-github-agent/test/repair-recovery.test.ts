import type { RepairRecoveryTarget } from '../src/repair-recovery.ts'
import { expect, it, vi } from 'vitest'
import { createAgentPermitPool } from '../src/agent-permit-pool.ts'
import { createRepairRecoveryController, parseRepairRecoveryRequest } from '../src/repair-recovery.ts'
import { err, ok } from '../src/result.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const commitSha = 'c'.repeat(40)
const baseSha = 'b'.repeat(40)
const taskId = `logged-finding:${'a'.repeat(64)}`
it('rejects malformed input without calling object coercion', () => {
  expect(parseRepairRecoveryRequest({ _tag: 'Plan', taskId: { toString: 1 }, commitSha })).toMatchObject({ _tag: 'Err' })
})
function fixture() {
  const target: RepairRecoveryTarget = {
    fence: 3,
    task: { id: taskId, kind: 'review_fix', repository: 'harlan-zw/example', pullRequestNumber: 24, revisionId: 'revision', updatedAt: '', repositoryMapping: repositoryMapping(), pullRequest: pullRequestItem({ state: 'closed', mergedAt: '2026-10-06', baseSha }), rounds: { number: 1, limit: 1, prior: [] }, pickup: { _tag: 'LoggedFinding', finding: { _tag: 'Logged', impact: 40, summary: 'Fix parser', details: { fingerprint: 'f'.repeat(64), identity: 'parser', location: { path: 'src/parser.ts', line: 1 }, proof: 'Loses input' } } } },
    proof: { _tag: 'RepairRecovery', commitSha, originalFence: 3, originalFailure: `Could not pin the repair artifact: fatal: invalid refspec '+${commitSha}:refs/harlan-github-agent/publications/${taskId}'` },
    report: { summary: 'Preserve parser input', checks: ['prior check'] },
  }
  let claimed = false
  let currentBase = baseSha
  const claimedTask = { ...target.task, state: { _tag: 'Running' as const, workerId: 'recovery', fence: 4, leaseExpiresAt: '2099-01-01' } }
  const staged: unknown[] = []
  const store = {
    inspectRepairRecovery: () => ok(target),
    claimRepairRecovery: vi.fn(() => {
      if (claimed)
        return err('The recovery already started.')
      claimed = true
      return ok(claimedTask)
    }),
    heartbeatTask: () => true,
    failTask: vi.fn(() => 'Failed' as const),
    completeTask: () => true,
    needsAttentionTask: () => true,
    supersedeTask: () => true,
    stagePublication: (input: unknown) => {
      staged.push(input)
      return { _tag: 'Staged' as const, commandId: 'command' }
    },
  }
  const worktrees = {
    inspectRecovery: async () => ok({ parentSha: baseSha, retainedRef: 'refs/heads/retained', changedPaths: ['src/parser.ts', 'test/parser.test.ts'], regressionPaths: ['test/parser.test.ts'] }),
    recover: vi.fn(async () => ok({ commitSha, baseSha, artifactRef: 'refs/artifact', digest: 'digest', changedFiles: 2 })),
  }
  const permits = createAgentPermitPool(1)
  const releaseHost = vi.fn()
  const controller = createRepairRecoveryController({ store, worktrees, canClaim: () => true, acquireHost: () => ({ release: releaseHost }), permits, now: () => new Date('2026-10-06'), workerId: 'recovery', onError: () => {}, validateMapping: async mapping => ok(mapping), github: {
    getPullRequestReviewSnapshot: async () => ok({ pullRequest: target.task.pullRequest }),
    getDefaultBranchSnapshot: async () => ok({ baseSha: currentBase }),
  } })
  return { controller, store, worktrees, staged, target, permits, releaseHost, moveBase: () => {
    currentBase = 'd'.repeat(40)
  } }
}

it('releases both slots when a durable claim fails unexpectedly', async () => {
  const task = fixture()
  task.store.claimRepairRecovery.mockImplementationOnce(() => {
    throw new Error('Journal unavailable')
  })
  await expect(task.controller.run({ _tag: 'Apply', taskId, commitSha, expectedBase: baseSha })).rejects.toThrow('Journal unavailable')
  expect(task.releaseHost).toHaveBeenCalledOnce()
  expect(task.permits.tryAcquire()).not.toBeNull()
  expect(task.worktrees.recover).not.toHaveBeenCalled()
})

it('plans a retained repair without claiming, running checks, or publishing', async () => {
  const task = fixture()
  expect(await task.controller.run({ _tag: 'Plan', taskId, commitSha })).toMatchObject({ _tag: 'Ok', value: { _tag: 'Plan', expectedBase: baseSha, regressionPaths: ['test/parser.test.ts'] } })
  expect(task.worktrees.recover).not.toHaveBeenCalled()
  expect(task.staged).toEqual([])
})

it('refuses an apply against a moved expected base before recovering', async () => {
  const task = fixture()
  task.moveBase()
  expect(await task.controller.run({ _tag: 'Apply', taskId, commitSha, expectedBase: baseSha })).toMatchObject({ _tag: 'Err' })
  expect(task.worktrees.recover).not.toHaveBeenCalled()
})

it('returns an accepted identity and stages one fenced publication after fresh recovery', async () => {
  const task = fixture()
  expect(await task.controller.run({ _tag: 'Apply', taskId, commitSha, expectedBase: baseSha })).toMatchObject({ _tag: 'Ok', value: { _tag: 'Accepted', taskId, fence: 4 } })
  await task.controller.settle(taskId)
  expect(task.staged).toEqual([expect.objectContaining({ taskId, fence: 4, publication: expect.objectContaining({ _tag: 'OpenPullRequest', commitSha, expectedHeadSha: baseSha }) })])
  expect(await task.controller.run({ _tag: 'Apply', taskId, commitSha, expectedBase: baseSha })).toMatchObject({ _tag: 'Err' })
  expect(task.staged).toHaveLength(1)
})

it('refuses publication when the base moves during fresh checks', async () => {
  const task = fixture()
  task.worktrees.recover.mockImplementation(async () => {
    task.moveBase()
    return ok({ commitSha, baseSha, artifactRef: 'refs/artifact', digest: 'digest', changedFiles: 2 })
  })
  await task.controller.run({ _tag: 'Apply', taskId, commitSha, expectedBase: baseSha })
  await task.controller.settle(taskId)
  expect(task.staged).toEqual([])
  expect(task.store.failTask).toHaveBeenCalledWith(expect.objectContaining({ taskId, fence: 4, reason: expect.stringContaining('base') }))
})
