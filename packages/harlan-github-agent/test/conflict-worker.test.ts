import type { ProviderCapture } from './fixtures.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE, OPENCODE_AGENT_PROFILE } from '../src/agent-profile.ts'
import { createConflictWorker } from '../src/conflict-worker.ts'
import { ok } from '../src/result.ts'
import { pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

const resolved = {
  outcome: 'resolved',
  summary: 'Resolved.',
  checks: ['pnpm test'],
  commitMessage: 'merge: reconcile parser changes',
}

function conflictTask(repository = repositoryMapping(), pullRequest = pullRequestItem({ baseSha: 'previous-base' })) {
  return {
    id: 'task-1',
    kind: 'resolve_conflict' as const,
    repository: repository.github,
    pullRequestNumber: pullRequest.number,
    revisionId: 'revision-1',
    state: { _tag: 'Running' as const, workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T01:10:00.000Z' },
    updatedAt: '2026-08-13T01:00:00.000Z',
    repositoryMapping: repository,
    pullRequest,
  }
}

function conflictWorkerOptions(repository: ReturnType<typeof repositoryMapping>, current: ReturnType<typeof pullRequestItem>) {
  return {
    github: { getPullRequest: () => Promise.resolve(ok(current)) },
    now: () => new Date('2026-08-13T01:00:00.000Z'),
    store: {
      getWorkerSession: () => 'stale-session',
      saveWorkerSession: () => undefined,
      updateAgentProgress: () => true,
    },
    validateMapping: () => Promise.resolve(ok(repository)),
    worktrees: {
      prepare: () => Promise.resolve(ok({ path: '/tmp/worktree', headSha: current.headSha, baseSha: current.baseSha, conflictedFiles: ['file.ts'] })),
      verify: () => Promise.resolve(ok({ digest: 'digest', changedFiles: 1 })),
      commit: () => Promise.resolve(ok({ commitSha: 'commit', baseSha: current.baseSha, artifactRef: 'artifact', digest: 'digest', changedFiles: 1 })),
    },
  }
}

describe('conflict worker', () => {
  it('runs the pinned Codex model and reasoning effort against the prepared worktree', async () => {
    const repository = repositoryMapping()
    const current = pullRequestItem({ baseSha: 'current-base' })
    const capture: ProviderCapture = { requests: [] }
    const worker = createConflictWorker({
      ...conflictWorkerOptions(repository, current),
      profile: CODEX_AGENT_PROFILE,
      provider: stubProvider(turnEvents(resolved), capture),
    })

    const result = await worker.run(conflictTask(repository), new AbortController().signal)

    expect(result._tag).toBe('Ok')
    expect(capture.requests).toEqual([expect.objectContaining({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      sessionId: 'stale-session',
      workspace: '/tmp/worktree',
    })])
  })

  it('runs DeepSeek at high reasoning when the provider is opencode', async () => {
    const repository = repositoryMapping()
    const current = pullRequestItem({ baseSha: 'current-base' })
    const capture: ProviderCapture = { requests: [] }
    const worker = createConflictWorker({
      ...conflictWorkerOptions(repository, current),
      profile: OPENCODE_AGENT_PROFILE,
      provider: stubProvider(turnEvents(resolved), capture, 'opencode'),
    })

    const result = await worker.run(conflictTask(repository), new AbortController().signal)

    expect(result._tag).toBe('Ok')
    expect(capture.requests[0]).toEqual(expect.objectContaining({
      model: 'opencode-go/deepseek-v4-flash',
      reasoningEffort: 'high',
    }))
  })

  it('accepts an outside contributor fork when the maintainer can modify the head', async () => {
    const repository = repositoryMapping()
    const current = pullRequestItem({
      baseSha: 'current-base',
      author: 'contributor',
      headRepository: 'contributor/example',
      maintainerCanModify: true,
    })
    const worker = createConflictWorker({
      ...conflictWorkerOptions(repository, current),
      profile: CODEX_AGENT_PROFILE,
      provider: stubProvider(turnEvents(resolved)),
    })

    const result = await worker.run(conflictTask(repository, current), new AbortController().signal)

    expect(result._tag).toBe('Ok')
  })

  it('rejects a contributor fork when the maintainer cannot modify the head', async () => {
    const repository = repositoryMapping()
    const current = pullRequestItem({
      baseSha: 'current-base',
      author: 'contributor',
      headRepository: 'contributor/example',
      maintainerCanModify: false,
    })
    const worker = createConflictWorker({
      ...conflictWorkerOptions(repository, current),
      profile: CODEX_AGENT_PROFILE,
      provider: stubProvider(turnEvents(resolved)),
    })

    const result = await worker.run(conflictTask(repository, current), new AbortController().signal)

    expect(result).toEqual({ _tag: 'Err', error: 'The pull request no longer matches the claimed head and base commit SHAs.' })
  })

  it('re-reads the pull request so the worktree merges the current base commit', async () => {
    const repository = repositoryMapping()
    const current = pullRequestItem({ baseSha: 'current-base' })
    let preparedBaseSha: string | undefined
    const worker = createConflictWorker({
      ...conflictWorkerOptions(repository, current),
      profile: CODEX_AGENT_PROFILE,
      provider: stubProvider(turnEvents(resolved)),
      worktrees: {
        prepare: (task) => {
          preparedBaseSha = task.pullRequest.baseSha
          return Promise.resolve(ok({ path: '/tmp/worktree', headSha: current.headSha, baseSha: current.baseSha, conflictedFiles: ['file.ts'] }))
        },
        verify: () => Promise.resolve(ok({ digest: 'digest', changedFiles: 1 })),
        commit: (_task, _worktree, _patch, message) => {
          expect(message).toBe('merge: reconcile parser changes')
          return Promise.resolve(ok({ commitSha: 'commit', baseSha: current.baseSha, artifactRef: 'artifact', digest: 'digest', changedFiles: 1 }))
        },
      },
    })

    const result = await worker.run(conflictTask(repository), new AbortController().signal)

    expect(result._tag).toBe('Ok')
    expect(preparedBaseSha).toBe('current-base')
  })
})
