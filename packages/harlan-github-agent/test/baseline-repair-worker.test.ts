import type { CodexOptions, ThreadOptions } from '@openai/codex-sdk'
import { describe, expect, it } from 'vitest'
import { createCodexBaselineRepairWorker } from '../src/baseline-repair-worker.ts'
import { ok } from '../src/result.ts'
import { pullRequestSubject, repositoryMapping } from './fixtures.ts'

describe('baseline repair worker', () => {
  it('lets the agent describe and publish a verified default branch CI fix', async () => {
    const disclosure = '> 🤖 AI disclosure: [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) modified this description. [My AI open-source policy](https://harlanzw.com/blog/ai-in-open-source).'
    const mapping = repositoryMapping()
    const pullRequest = pullRequestSubject({ mergeState: 'clean' })
    let commitMessage = ''
    const response = {
      outcome: 'repaired',
      summary: 'Fixed the broken generated types.',
      checks: ['pnpm test'],
      commitMessage: 'fix(types): regenerate runtime declarations',
      pullRequestTitle: 'fix(types): regenerate runtime declarations',
      pullRequestBody: `Regenerates declarations so default branch CI passes.\n\n${disclosure}`,
    }
    const worker = createCodexBaselineRepairWorker({
      createCodex: (_options: CodexOptions) => ({
        startThread: (_thread: ThreadOptions) => ({
          runStreamed: () => Promise.resolve({
            events: (async function* () {
              yield { type: 'thread.started' as const, thread_id: 'baseline-session' }
              yield { type: 'item.completed' as const, item: { type: 'agent_message' as const, id: 'message', text: JSON.stringify(response) } }
              yield { type: 'turn.completed' as const, usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }
            })(),
          }),
        }),
        resumeThread: () => { throw new Error('A new Baseline repair must start a session.') },
      }),
      github: {
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [{ id: 1, source: { _tag: 'CheckRun', appId: 15368 }, name: 'test', status: 'completed', conclusion: 'failure' }] },
          body: '',
          checks: { _tag: 'Available', checks: [] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          reviews: [],
        })),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        getWorkerSession: () => null,
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: value => Promise.resolve(ok(value)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/baseline-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.baseSha })),
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 2 })),
        commit: (_task, _worktree, _patch, message) => {
          commitMessage = message
          return Promise.resolve(ok({
            commitSha: 'repair-commit',
            baseSha: pullRequest.baseSha,
            artifactRef: 'artifact-ref',
            digest: 'patch-digest',
            changedFiles: 2,
          }))
        },
      },
    })

    const result = await worker.run({
      id: 'baseline-task',
      kind: 'baseline_repair',
      repository: mapping.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'baseline-agent', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: mapping,
      pullRequest,
    }, new AbortController().signal)

    expect(commitMessage).toBe(response.commitMessage)
    if (result._tag === 'Ok' && result.value._tag === 'Publish' && result.value.publication._tag === 'OpenPullRequest')
      expect(result.value.publication.pullRequestBody.match(/🤖 AI disclosure:/g)).toHaveLength(1)
    expect(result).toEqual(ok({
      _tag: 'Publish',
      publication: expect.objectContaining({
        _tag: 'OpenPullRequest',
        taskKind: 'baseline_repair',
        expectedHeadSha: pullRequest.baseSha,
        pullRequestTitle: response.pullRequestTitle,
        headRef: expect.stringContaining('baseline-ci-'),
      }),
    }))
  })
})
