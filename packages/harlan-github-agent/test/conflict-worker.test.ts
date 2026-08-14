import type { CodexOptions, ThreadOptions } from '@openai/codex-sdk'
import { describe, expect, it } from 'vitest'
import { createCodexConflictWorker } from '../src/conflict-worker.ts'
import { ok } from '../src/result.ts'
import { pullRequestSubject, repositoryMapping } from './fixtures.ts'

describe('codex conflict Worker', () => {
  it('uses the local ChatGPT login with the pinned model and reasoning effort', async () => {
    const repository = repositoryMapping()
    const pullRequest = pullRequestSubject({ baseSha: 'current-base' })
    const claimedPullRequest = pullRequestSubject({ baseSha: 'previous-base' })
    let clientOptions: CodexOptions | undefined
    let threadOptions: ThreadOptions | undefined
    let preparedBaseSha: string | undefined
    let resumeAttempts = 0

    const worker = createCodexConflictWorker({
      createCodex: (options) => {
        clientOptions = options
        const thread = {
          runStreamed: () => Promise.resolve({
            events: (async function* () {
              yield { type: 'thread.started' as const, thread_id: 'session-1' }
              yield {
                type: 'item.completed' as const,
                item: { id: 'message-1', type: 'agent_message' as const, text: JSON.stringify({ outcome: 'resolved', summary: 'Resolved.', checks: ['pnpm test'], commitMessage: 'merge: reconcile parser changes' }) },
              }
              yield { type: 'turn.completed' as const, usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 1 } }
            })(),
          }),
        }
        return {
          startThread: (options) => {
            threadOptions = options
            return thread
          },
          resumeThread: () => ({
            runStreamed: () => {
              resumeAttempts += 1
              return Promise.resolve({
                events: (async function* () {
                  throw new Error('thread/resume failed: no rollout found for thread id stale-session')
                })(),
              })
            },
          }),
        }
      },
      github: {
        getPullRequest: () => Promise.resolve(ok(pullRequest)),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        getWorkerSession: () => 'stale-session',
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(repository)),
      worktrees: {
        prepare: (task) => {
          preparedBaseSha = task.pullRequest.baseSha
          return Promise.resolve(ok({ path: '/tmp/worktree', headSha: pullRequest.headSha, baseSha: pullRequest.baseSha, conflictedFiles: ['file.ts'] }))
        },
        verify: () => Promise.resolve(ok({ digest: 'digest', changedFiles: 1 })),
        commit: (_task, _worktree, _patch, message) => {
          expect(message).toBe('merge: reconcile parser changes')
          return Promise.resolve(ok({ commitSha: 'commit', baseSha: pullRequest.baseSha, artifactRef: 'artifact', digest: 'digest', changedFiles: 1 }))
        },
      },
    })

    const result = await worker.run({
      id: 'task-1',
      kind: 'resolve_conflict',
      repository: repository.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T01:10:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: repository,
      pullRequest: claimedPullRequest,
    }, new AbortController().signal)

    expect(result._tag).toBe('Ok')
    expect(resumeAttempts).toBe(1)
    expect(preparedBaseSha).toBe('current-base')
    expect(clientOptions).not.toHaveProperty('apiKey')
    expect(clientOptions).toEqual({})
    expect(threadOptions).toEqual(expect.objectContaining({
      model: 'gpt-5.6-terra',
      modelReasoningEffort: 'medium',
    }))
  })
})
