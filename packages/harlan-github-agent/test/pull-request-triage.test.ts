import type { ProviderCapture } from './fixtures.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { createPullRequestTriageAgent } from '../src/pull-request-triage.ts'
import { agentRuntime, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

describe('pull request triage Agent', () => {
  it('uses the cheap profile and returns one conservative route', async () => {
    const capture: ProviderCapture = { requests: [] }
    const agent = createPullRequestTriageAgent({
      now: () => new Date('2026-08-28T01:00:00.000Z'),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        _tag: 'ADVERSARIAL_REVIEW_SKIPPED',
        reason: 'Only prose documentation changed.',
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
      pullRequest: pullRequestItem({ mergeState: 'clean' }),
      rerun: { _tag: 'NotRequested' },
    }, {
      body: 'Correct a typo in the guide.',
      changedFiles: ['docs/guide.md'],
    }, new AbortController().signal)

    expect(result).toEqual({
      _tag: 'Ok',
      value: {
        _tag: 'ADVERSARIAL_REVIEW_SKIPPED',
        reason: 'Only prose documentation changed.',
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
