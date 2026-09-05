import type { ProviderCapture } from './fixtures.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE, OPENCODE_AGENT_PROFILE } from '../src/agent-profile.ts'
import { createConflictWorker } from '../src/conflict-worker.ts'
import { ok } from '../src/result.ts'
import { agentRuntime, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

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
      prepare: () => Promise.resolve(ok({ _tag: 'Conflicted' as const, worktree: { path: '/tmp/worktree', headSha: current.headSha, baseSha: current.baseSha, conflictedFiles: ['file.ts'] } })),
      verify: () => Promise.resolve(ok({ digest: 'digest', changedFiles: 1 })),
      commit: () => Promise.resolve(ok({ commitSha: 'commit', baseSha: current.baseSha, artifactRef: 'artifact', digest: 'digest', changedFiles: 1 })),
    },
  }
}

describe('conflict worker', () => {
  it('completes a clean merge without an agent turn and asks GitHub to recompute once', async () => {
    const repository = repositoryMapping()
    const current = pullRequestItem({ baseSha: 'current-base' })
    const capture: ProviderCapture = { requests: [] }
    let reads = 0
    const options = conflictWorkerOptions(repository, current)
    const worker = createConflictWorker({
      ...options,
      github: { getPullRequest: () => {
        reads += 1
        return Promise.resolve(ok(current))
      } },
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents(resolved), capture)),
      worktrees: {
        ...options.worktrees,
        prepare: () => Promise.resolve(ok({ _tag: 'CleanMerge' as const, headSha: current.headSha, baseSha: 'current-base', baseRef: 'main' })),
      },
    })

    const result = await worker.run(conflictTask(repository), new AbortController().signal)

    expect(result).toEqual(ok({
      _tag: 'Completed',
      evidence: JSON.stringify({ _tag: 'CleanMerge', headSha: current.headSha, baseSha: 'current-base', baseRef: 'main' }),
    }))
    expect(capture.requests).toEqual([])
    // The first read claims the pull request. The second is the GET that makes
    // GitHub recompute the stale mergeable state.
    expect(reads).toBe(2)
  })

  it('runs the Codex profile\'s conflict model against the prepared worktree', async () => {
    const repository = repositoryMapping()
    const current = pullRequestItem({ baseSha: 'current-base' })
    const capture: ProviderCapture = { requests: [] }
    const worker = createConflictWorker({
      ...conflictWorkerOptions(repository, current),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents(resolved), capture)),
    })

    const result = await worker.run(conflictTask(repository), new AbortController().signal)

    expect(result._tag).toBe('Ok')
    expect(capture.requests).toEqual([expect.objectContaining({
      model: CODEX_AGENT_PROFILE.roles.conflict_resolution.model,
      reasoningEffort: CODEX_AGENT_PROFILE.roles.conflict_resolution.reasoningEffort,
      sessionId: 'stale-session',
      workspace: '/tmp/worktree',
    })])
  })

  it('runs the opencode profile\'s conflict model when the provider is opencode', async () => {
    const repository = repositoryMapping()
    const current = pullRequestItem({ baseSha: 'current-base' })
    const capture: ProviderCapture = { requests: [] }
    const worker = createConflictWorker({
      ...conflictWorkerOptions(repository, current),
      runtime: agentRuntime(OPENCODE_AGENT_PROFILE, stubProvider(turnEvents(resolved), capture, 'opencode')),
    })

    const result = await worker.run(conflictTask(repository), new AbortController().signal)

    expect(result._tag).toBe('Ok')
    // The model each profile pins moves whenever a provider ships a better one.
    // What must hold is that the worker asks the profile for the running
    // provider, so the assertion reads the profile rather than repeating it.
    expect(capture.requests[0]).toEqual(expect.objectContaining({
      model: OPENCODE_AGENT_PROFILE.roles.conflict_resolution.model,
      reasoningEffort: OPENCODE_AGENT_PROFILE.roles.conflict_resolution.reasoningEffort,
    }))
    expect(OPENCODE_AGENT_PROFILE.roles.conflict_resolution.model).not.toBe(CODEX_AGENT_PROFILE.roles.conflict_resolution.model)
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
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents(resolved))),
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
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents(resolved))),
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
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents(resolved))),
      worktrees: {
        prepare: (task) => {
          preparedBaseSha = task.pullRequest.baseSha
          return Promise.resolve(ok({ _tag: 'Conflicted' as const, worktree: { path: '/tmp/worktree', headSha: current.headSha, baseSha: current.baseSha, conflictedFiles: ['file.ts'] } }))
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

  it('tells the agent the conflicted files, both SHAs, and the check budget', async () => {
    const repository = repositoryMapping()
    const current = pullRequestItem({ baseSha: 'current-base', headSha: 'head-sha', baseRef: 'feat/parent' })
    const capture: ProviderCapture = { requests: [] }
    const worker = createConflictWorker({
      ...conflictWorkerOptions(repository, current),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents(resolved), capture)),
      worktrees: {
        ...conflictWorkerOptions(repository, current).worktrees,
        prepare: () => Promise.resolve(ok({ _tag: 'Conflicted' as const, worktree: { path: '/tmp/worktree', headSha: 'head-sha', baseSha: 'current-base', conflictedFiles: ['src/a.ts', 'src/b.vue'] } })),
      },
    })

    const result = await worker.run(conflictTask(repository, current), new AbortController().signal)

    expect(result._tag).toBe('Ok')
    const prompt = capture.requests[0]?.prompt ?? ''
    expect(prompt).toContain('Pull request head: head-sha')
    expect(prompt).toContain('Base branch: feat/parent at current-base')
    expect(prompt).toContain('- src/a.ts\n- src/b.vue')
    expect(prompt).toContain('- eslint on the conflicted files')
    expect(prompt).toContain('- vitest on the test files that import the conflicted files')
    expect(prompt).toContain('- git diff --check')
    expect(prompt).toContain('Do not run the full test suite, the full typecheck, a build, or a toolchain install.')
    expect(prompt).toContain('Never use npx.')
    expect(prompt).toContain('Leave no conflict markers in any file.')
    expect(prompt).not.toContain('unit-tests skill')
  })
})
