import type { CodexOptions, ThreadOptions } from '@openai/codex-sdk'
import { describe, expect, it } from 'vitest'
import { createCodexIssueWorkWorker } from '../src/issue-work-worker.ts'
import { ok } from '../src/result.ts'
import { issueSubject, repositoryMapping } from './fixtures.ts'

describe('codex issue work worker', () => {
  it('resumes triage, implements the issue, and prepares repository metadata', async () => {
    const repository = repositoryMapping()
    const issue = issueSubject()
    let resumedSession: string | undefined
    let threadOptions: ThreadOptions | undefined
    const worker = createCodexIssueWorkWorker({
      createCodex: (_options: CodexOptions) => {
        const thread = {
          runStreamed: () => Promise.resolve({
            events: (async function* () {
              yield {
                type: 'item.completed' as const,
                item: {
                  id: 'message-1',
                  type: 'agent_message' as const,
                  text: JSON.stringify({
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
                  }),
                },
              }
              yield { type: 'turn.completed' as const, usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 1 } }
            })(),
          }),
        }
        return {
          startThread: (options: ThreadOptions) => {
            threadOptions = options
            return thread
          },
          resumeThread: (sessionId: string, options: ThreadOptions) => {
            resumedSession = sessionId
            threadOptions = options
            return thread
          },
        }
      },
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

    expect(resumedSession).toBe('triage-session')
    expect(threadOptions).toEqual(expect.objectContaining({ model: 'gpt-5.6-terra', modelReasoningEffort: 'medium' }))
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
    const issue = issueSubject()
    let workspaceCreated = false
    const worker = createCodexIssueWorkWorker({
      createCodex: () => { throw new Error('Issue work must not start.') },
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
