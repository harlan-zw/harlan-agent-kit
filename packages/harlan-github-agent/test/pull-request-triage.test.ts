import type { ProviderCapture } from './fixtures.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { createPullRequestTriageAgent } from '../src/pull-request-triage.ts'
import { agentRuntime, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

describe('pull request triage Agent', () => {
  it('skips a conventional chore without starting an Agent', async () => {
    const capture: ProviderCapture = { requests: [] }
    const agent = createPullRequestTriageAgent({
      now: () => new Date('2026-08-28T01:00:00.000Z'),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider([], capture)),
      store: {
        getWorkerSession: () => null,
        saveWorkerSession: () => undefined,
      },
      workspace: '/tmp/harlan-github-agent',
    })

    const result = await agent.run({
      id: 'review-task',
      kind: 'adversarial_review',
      repository: 'harlan-zw/gscdump',
      pullRequestNumber: 35,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-28T02:00:00.000Z' },
      updatedAt: '2026-08-28T01:00:00.000Z',
      repositoryMapping: repositoryMapping(),
      pullRequest: pullRequestItem({
        mergeState: 'clean',
        title: 'chore: update workspace dependencies',
      }),
      rerun: { _tag: 'NotRequested' },
    }, {
      body: 'Refresh the workspace dependencies.',
      changedFiles: [
        'package.json',
        'packages/engine/test/icebird-bigint-stringify.test.ts',
        'patches/icebird@0.8.26.patch',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
      ],
    }, new AbortController().signal)

    expect(result).toEqual({
      _tag: 'Ok',
      value: {
        _tag: 'ADVERSARIAL_REVIEW_SKIPPED',
        reason: 'The pull request uses the conventional non-breaking chore type.',
      },
    })
    expect(capture.requests).toEqual([])
  })

  it('uses the cheap profile and returns one conservative route', async () => {
    const capture: ProviderCapture = { requests: [] }
    const agent = createPullRequestTriageAgent({
      now: () => new Date('2026-08-28T01:00:00.000Z'),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        _tag: 'ADVERSARIAL_REVIEW_REQUIRED',
        reason: 'The pull request declares a breaking change.',
      }), capture)),
      store: {
        getWorkerSession: () => null,
        saveWorkerSession: () => undefined,
      },
      workspace: '/tmp/harlan-github-agent',
    })

    const result = await agent.run({
      id: 'review-task',
      kind: 'adversarial_review',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-28T02:00:00.000Z' },
      updatedAt: '2026-08-28T01:00:00.000Z',
      repositoryMapping: repositoryMapping(),
      pullRequest: pullRequestItem({
        mergeState: 'clean',
        title: 'chore!: replace the deployment contract',
      }),
      rerun: { _tag: 'NotRequested' },
    }, {
      body: 'Replace the deployment contract.',
      changedFiles: ['src/deployment.ts'],
    }, new AbortController().signal)

    expect(result).toEqual({
      _tag: 'Ok',
      value: {
        _tag: 'ADVERSARIAL_REVIEW_REQUIRED',
        reason: 'The pull request declares a breaking change.',
      },
    })
    expect(capture.requests).toEqual([expect.objectContaining({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      sessionId: null,
    })])
    expect(capture.requests[0]?.prompt).toContain('Do not use tools or inspect the repository')
    expect(capture.requests[0]?.prompt).toContain('Any uncertainty requires ADVERSARIAL_REVIEW_REQUIRED')
  })
})
