import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { createBaselineRepairWorker } from '../src/baseline-repair-worker.ts'
import { ok } from '../src/result.ts'
import { agentRuntime, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

describe('baseline repair worker', () => {
  it('lets the agent describe and publish a verified default branch CI fix', async () => {
    const disclosure = '> 🤖 AI disclosure: [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) modified this description. [My AI open-source policy](https://harlanzw.com/blog/ai-in-open-source).'
    const mapping = repositoryMapping()
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    let commitMessage = ''
    const response = {
      outcome: 'repaired',
      summary: 'Fixed the broken generated types.',
      checks: ['pnpm test'],
      commitMessage: 'fix(types): regenerate runtime declarations',
      pullRequestTitle: 'fix(types): regenerate runtime declarations',
      pullRequestBody: `Regenerates declarations so default branch CI passes.\n\n${disclosure}`,
    }
    const worker = createBaselineRepairWorker({
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents(response))),
      github: {
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [{ id: 1, failure: { _tag: 'NotAsked' as const }, source: { _tag: 'CheckRun', appId: 15368 }, name: 'test', status: 'completed', conclusion: 'failure' }] },
          body: '',
          checks: { _tag: 'Available', checks: [] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          requiredChecks: { _tag: 'None' as const },
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

  it('publishes a verified patch with safe metadata when Agent output is malformed', async () => {
    const mapping = repositoryMapping()
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const recorded: Array<{ taskId: string, item: unknown }> = []
    let commitMessage = ''
    const worker = createBaselineRepairWorker({
      activityLog: {
        record: (taskId, item) => recorded.push({ taskId, item }),
      },
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider([
        { _tag: 'SessionStarted', sessionId: 'session-1' },
        { _tag: 'Message', text: '{' },
        { _tag: 'TurnCompleted' },
      ])),
      github: {
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Found', body: '### Description\n\n### Linked Issues' })),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [{ id: 1, failure: { _tag: 'NotAsked' as const }, source: { _tag: 'CheckRun', appId: 15368 }, name: 'test', status: 'completed', conclusion: 'failure' }] },
          body: '',
          checks: { _tag: 'Available', checks: [] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          requiredChecks: { _tag: 'None' as const },
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

    expect(commitMessage).toBe('fix: repair default branch CI')
    expect(recorded).toEqual([{
      taskId: 'baseline-task',
      item: expect.objectContaining({
        _tag: 'Reasoning',
        text: expect.stringMatching(/malformed Baseline repair JSON[\s\S]*\{/),
      }),
    }])
    expect(result).toEqual(ok({
      _tag: 'Publish',
      publication: expect.objectContaining({
        pullRequestTitle: 'fix: repair default branch CI',
        pullRequestBody: expect.stringMatching(/### Description[\s\S]*### Linked Issues[\s\S]*Repairs failing default branch CI\./),
      }),
    }))
  })

  it.each([
    ['the default branch went green', { green: true }, 'Default branch CI no longer fails'],
    ['the default branch moved past the failing commit', { moved: true }, 'The default branch moved to'],
  ])('retires the repair when %s', async (_name, scenario: { green?: boolean, moved?: boolean }, expected) => {
    const mapping = repositoryMapping()
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const baseChecks = scenario.green === true
      ? []
      : [{ id: 1, failure: { _tag: 'NotAsked' as const }, source: { _tag: 'CheckRun' as const, appId: 15368 }, name: 'test', status: 'completed' as const, conclusion: 'failure' }]
    const preparedHead = scenario.moved === true ? 'f'.repeat(40) : pullRequest.baseSha
    const worker = createBaselineRepairWorker({
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({}))),
      github: {
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: baseChecks },
          body: '',
          checks: { _tag: 'Available', checks: [] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          requiredChecks: { _tag: 'None' as const },
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
        prepare: () => Promise.resolve(ok({ path: '/tmp/baseline-worktree', baseSha: pullRequest.baseSha, headSha: preparedHead })),
        verify: () => Promise.reject(new Error('A retired repair must not verify a patch.')),
        commit: () => Promise.reject(new Error('A retired repair must not commit.')),
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

    expect(result).toEqual(ok({ _tag: 'Obsolete', evidence: expect.stringContaining(expected) }))
  })
})
