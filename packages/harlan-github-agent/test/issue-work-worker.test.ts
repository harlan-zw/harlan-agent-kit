import type { ProviderCapture } from './fixtures.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { createIssueWorkWorker } from '../src/issue-work-worker.ts'
import { ok } from '../src/result.ts'
import { agentRuntime, issueItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

describe('issue work worker', () => {
  it('resumes triage, implements the issue, and prepares repository metadata', async () => {
    const repository = repositoryMapping()
    const issue = issueItem()
    const capture: ProviderCapture = { requests: [] }
    const worker = createIssueWorkWorker({
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        outcome: 'implemented',
        summary: 'Fixed the parser.',
        checks: ['pnpm test'],
        commitMessage: 'fix(parser): preserve valid input',
        pullRequestTitle: 'fix: broken thing',
        pullRequestBody: `### Description

Fixed the parser.

> 🤖 AI disclosure: [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) modified this description. [My AI open-source policy](https://harlanzw.com/blog/ai-in-open-source).

### Linked Issues

Closes #12.`,
      }), capture)),
      github: {
        getIssueTriageSnapshot: () => Promise.resolve(ok({ body: 'Reproduction', comments: [], state: 'open', title: issue.title, updatedAt: '2026-08-13T01:00:00.000Z' })),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Found', body: '### Description\n\n### Linked Issues' })),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        getWorkerSession: (_repository, _number, _role, scopeDigest) => scopeDigest === undefined ? null : 'triage-session',
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(repository)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/issue-work', headSha: 'base-sha', baseSha: 'base-sha' })),
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 2 })),
        commit: (_task, _worktree, _patch, message) => {
          expect(message).toBe('fix(parser): preserve valid input')
          return Promise.resolve(ok({ commitSha: 'commit-sha', baseSha: 'base-sha', artifactRef: 'artifact-ref', digest: 'patch-digest', changedFiles: 2 }))
        },
      },
    })

    const result = await worker.run({
      id: 'issue-work-task',
      kind: 'issue_work',
      repository: repository.github,
      issueNumber: issue.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T01:10:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: repository,
      issue,
    }, new AbortController().signal)

    expect(capture.requests).toEqual([expect.objectContaining({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      sessionId: 'triage-session',
      workspace: '/tmp/issue-work',
    })])
    expect(result).toEqual(ok({
      _tag: 'Publish',
      publication: expect.objectContaining({
        _tag: 'OpenPullRequest',
        taskKind: 'issue_work',
        issueNumber: 12,
        headRef: 'fix/issue-12',
        commitSha: 'commit-sha',
        expectedHeadSha: 'base-sha',
        pullRequestTitle: 'fix: broken thing',
        pullRequestBody: expect.stringContaining('Closes #12.'),
      }),
    }))
  })

  it('rejects issue work without the exact triage session', async () => {
    const repository = repositoryMapping()
    const issue = issueItem()
    let workspaceCreated = false
    const worker = createIssueWorkWorker({
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider([])),
      github: {
        getIssueTriageSnapshot: () => Promise.resolve(ok({
          body: 'Changed after triage',
          comments: [],
          state: 'open',
          title: issue.title,
          updatedAt: '2026-08-13T01:05:00.000Z',
        })),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
      },
      now: () => new Date('2026-08-13T01:06:00.000Z'),
      store: {
        getWorkerSession: () => null,
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(repository)),
      worktrees: {
        prepare: () => {
          workspaceCreated = true
          return Promise.resolve(ok({ path: '/tmp/issue-work', headSha: 'base-sha', baseSha: 'base-sha' }))
        },
        verify: () => Promise.reject(new Error('Issue work must not be verified.')),
        commit: () => Promise.reject(new Error('Issue work must not be committed.')),
      },
    })

    const result = await worker.run({
      id: 'issue-work-task',
      kind: 'issue_work',
      repository: repository.github,
      issueNumber: issue.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T01:10:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: repository,
      issue,
    }, new AbortController().signal)

    expect(workspaceCreated).toBe(true)
    expect(result).toEqual({ _tag: 'Err', error: 'The issue changed before work started.' })
  })
})
