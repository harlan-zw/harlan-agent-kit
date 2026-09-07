import type { AgentEvent, AgentProvider } from '../src/agent-provider.ts'
import type { PullRequestTemplate } from '../src/github-agent-source.ts'
import type { OpenAgentPullRequest, PullRequestBase } from '../src/types.ts'
import type { IssueWorktreeManager } from '../src/worktree.ts'
import type { ProviderCapture } from './fixtures.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCHEMA_VERSION } from '@coldtea/pr-lens-schema'
import { afterEach, describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { createIssueWorkWorker } from '../src/issue-work-worker.ts'
import { issueSnapshotDigest } from '../src/item-agent.ts'
import { ok } from '../src/result.ts'
import { agentRuntime, issueItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

describe('issue work worker', () => {
  it('closes every combined issue and stacks on the base a Batch chose', async () => {
    const repository = repositoryMapping()
    const issue = issueItem()
    const bases: PullRequestBase[] = []
    const worker = createIssueWorkWorker({
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        outcome: 'implemented',
        summary: 'Fixed both.',
        checks: ['pnpm test'],
        commitMessage: 'fix: shared helper',
        pullRequestTitle: 'fix: shared helper',
        // The Agent forgot the combined issue, so the controller substitutes metadata that closes both.
        pullRequestBody: '### Description\n\nFixed.\n\n### Linked Issues\n\nCloses #12.',
      }))),
      github: {
        getIssueTriageSnapshot: () => Promise.resolve(ok({ body: 'Body', comments: [], state: 'open', title: issue.title, updatedAt: '2026-08-13T01:00:00.000Z' })),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Found', body: '### Description\n\n### Linked Issues' })),
        listPullRequestFiles: () => Promise.reject(new Error('A planned base needs no overlap check.')),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        getIssueTriageEvidence: () => null,
        getWorkerSession: () => 'triage-session',
        listOpenAgentPullRequests: () => [],
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(repository)),
      worktrees: {
        prepare: (_task, base) => {
          bases.push(base)
          return Promise.resolve(ok({ path: '/tmp/issue-work', headSha: 'stack-head', baseSha: 'stack-head', defaultBranchSha: 'main-sha' }))
        },
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 1, changedPaths: ['src/helper.ts'] })),
        restack: () => Promise.reject(new Error('A planned base never restacks.')),
        commit: () => Promise.resolve(ok({ commitSha: 'commit-sha', baseSha: 'stack-head', artifactRef: 'artifact-ref', digest: 'patch-digest', changedFiles: 1 })),
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
    }, new AbortController().signal, {
      combinedIssues: [{ number: 13, title: 'Same helper', body: 'Also broken.' }],
      base: { _tag: 'Stacked', ref: 'fix/issue-9', pullRequestNumber: 9, headSha: 'stack-head' },
    })

    expect(bases).toEqual([{ _tag: 'Stacked', ref: 'fix/issue-9', pullRequestNumber: 9, headSha: 'stack-head' }])
    if (result._tag !== 'Ok' || result.value._tag !== 'Publish' || result.value.publication._tag !== 'OpenPullRequest')
      throw new Error('Expected a pull request publication.')
    expect(result.value.publication.baseRef).toBe('fix/issue-9')
    expect(result.value.publication.pullRequestBody).toContain('Closes #12.')
    expect(result.value.publication.pullRequestBody).toContain('Closes #13.')
  })

  it('refuses an Agent feedback patch outside its trusted skill target', async () => {
    const repository = repositoryMapping()
    const issue = issueItem()
    let committed = false
    const worker = createIssueWorkWorker({
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        outcome: 'implemented',
        summary: 'Changed the controller.',
        checks: ['pnpm test'],
        commitMessage: 'fix: change the controller',
        pullRequestTitle: 'fix: change the controller',
        pullRequestBody: '### Description\n\nChanged it.\n\n### Linked Issues\n\nCloses #12.',
      }))),
      github: {
        getIssueTriageSnapshot: () => Promise.resolve(ok({ body: 'Skill proposal', comments: [], state: 'open', title: issue.title, updatedAt: '2026-08-13T01:00:00.000Z' })),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Found', body: '### Description\n\n### Linked Issues' })),
        listPullRequestFiles: () => Promise.resolve(ok([])),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        getIssueTriageEvidence: () => null,
        getRoutineIssueSource: () => ({ routineName: 'agent-feedback', target: 'harlan-agent-kit/skills/adversarial-review/SKILL.md' }),
        getWorkerSession: () => 'triage-session',
        listOpenAgentPullRequests: () => [],
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(repository)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/issue-work', headSha: 'base-sha', baseSha: 'base-sha', defaultBranchSha: 'base-sha' })),
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 1, changedPaths: ['src/controller.ts'] })),
        restack: () => Promise.reject(new Error('Issue work must not restack.')),
        commit: () => {
          committed = true
          return Promise.resolve(ok({ commitSha: 'commit-sha', baseSha: 'base-sha', artifactRef: 'artifact-ref', digest: 'patch-digest', changedFiles: 1 }))
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

    expect(result).toEqual({ _tag: 'Err', error: 'Agent feedback issue work changed files outside its skill target.' })
    expect(committed).toBe(false)
  })

  it('resumes triage through personal authentication and prepares repository metadata', async () => {
    const repository = repositoryMapping({ authentication: 'user', ownership: 'maintained', conflictResolution: false })
    const issue = issueItem()
    const capture: ProviderCapture = { requests: [] }
    let snapshotReads = 0
    const worker = createIssueWorkWorker({
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        outcome: 'implemented',
        summary: 'Fixed the parser.',
        checks: ['pnpm test'],
        commitMessage: 'fix(parser): preserve valid input',
        pullRequestTitle: 'fix: broken thing',
        pullRequestBody: `### Description

Fixed the parser.

> 🤖 AI disclosure: [Codex](https://openai.com/codex) modified this description.

### Linked Issues

Closes #12.`,
      }), capture)),
      github: {
        getIssueTriageSnapshot: () => {
          snapshotReads += 1
          return Promise.resolve(ok({
            body: 'Reproduction',
            comments: [],
            state: 'open',
            title: issue.title,
            updatedAt: snapshotReads === 1 ? '2026-08-13T01:00:00.000Z' : '2026-08-13T01:05:00.000Z',
          }))
        },
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Found', body: '### Description\n\n### Linked Issues' })),
        listPullRequestFiles: () => Promise.resolve(ok([])),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        getIssueTriageEvidence: () => null,
        getWorkerSession: (_repository, _number, _role, scopeDigest) => scopeDigest === undefined ? null : 'triage-session',
        listOpenAgentPullRequests: () => [],
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(repository)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/issue-work', headSha: 'base-sha', baseSha: 'base-sha', defaultBranchSha: 'base-sha' })),
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 2, changedPaths: ['src/parser.ts', 'test/parser.test.ts'] })),
        restack: () => Promise.reject(new Error('Issue work must not restack without a stack base.')),
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
    expect(snapshotReads).toBe(2)
    expect(result).toEqual(ok({
      _tag: 'Publish',
      usage: { _tag: 'Unavailable' },
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
    expect(result).toEqual(ok(expect.objectContaining({
      publication: expect.objectContaining({
        pullRequestBody: expect.stringContaining('> 🤖 AI disclosure: [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) modified this description. [My AI open-source policy](https://harlanzw.com/blog/ai-in-open-source).'),
      }),
    })))
    expect(JSON.stringify(result)).not.toContain('[Codex]')
  })

  it('rejects issue work when a human comment changes its meaning', async () => {
    const repository = repositoryMapping()
    const issue = issueItem()
    const snapshots = [
      { body: 'Reproduction', comments: [], state: 'open' as const, title: issue.title, updatedAt: '2026-08-13T01:00:00.000Z' },
      { body: 'Reproduction', comments: ['Use a different fix.'], state: 'open' as const, title: issue.title, updatedAt: '2026-08-13T01:05:00.000Z' },
    ]
    let snapshotReads = 0
    let committed = false
    const worker = createIssueWorkWorker({
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        outcome: 'implemented',
        summary: 'Fixed the parser.',
        checks: ['pnpm test'],
        commitMessage: 'fix(parser): preserve valid input',
        pullRequestTitle: 'fix: broken thing',
        pullRequestBody: '### Description\n\nFixed the parser.\n\n### Linked Issues\n\nCloses #12.',
      }))),
      github: {
        getIssueTriageSnapshot: () => Promise.resolve(ok(snapshots[Math.min(snapshotReads++, 1)]!)),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Found', body: '### Description\n\n### Linked Issues' })),
        listPullRequestFiles: () => Promise.resolve(ok([])),
      },
      now: () => new Date('2026-08-13T01:06:00.000Z'),
      store: {
        getIssueTriageEvidence: () => null,
        getWorkerSession: () => 'triage-session',
        listOpenAgentPullRequests: () => [],
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(repository)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/issue-work', headSha: 'base-sha', baseSha: 'base-sha', defaultBranchSha: 'base-sha' })),
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 2, changedPaths: ['src/parser.ts', 'test/parser.test.ts'] })),
        restack: () => Promise.reject(new Error('Issue work must not restack without a stack base.')),
        commit: () => {
          committed = true
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

    expect(result).toEqual({ _tag: 'Err', error: 'The issue changed before the controller committed the fix.' })
    expect(committed).toBe(false)
  })

  it('publishes the patch with safe metadata when Agent output is malformed', async () => {
    const repository = repositoryMapping()
    const issue = issueItem()
    let commitMessage = ''
    const recorded: Array<{ taskId: string, item: unknown }> = []
    const worker = createIssueWorkWorker({
      activityLog: {
        record: (taskId, item) => recorded.push({ taskId, item }),
      },
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider([
        { _tag: 'SessionStarted', sessionId: 'session-1' },
        { _tag: 'Message', text: '{ broken ghp_Abcdefghijklmnopqrstuvwx' },
        { _tag: 'TurnCompleted' },
      ])),
      github: {
        getIssueTriageSnapshot: () => Promise.resolve(ok({ body: 'Reproduction', comments: [], state: 'open', title: issue.title, updatedAt: '2026-08-13T01:00:00.000Z' })),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Found', body: '### Description\n\n### Linked Issues' })),
        listPullRequestFiles: () => Promise.resolve(ok([])),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        getIssueTriageEvidence: () => null,
        getWorkerSession: (_repository, _number, _role, scopeDigest) => scopeDigest === undefined ? null : 'triage-session',
        listOpenAgentPullRequests: () => [],
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(repository)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/issue-work', headSha: 'base-sha', baseSha: 'base-sha', defaultBranchSha: 'base-sha' })),
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 1, changedPaths: ['src/parser.ts'] })),
        restack: () => Promise.reject(new Error('Issue work must not restack without a stack base.')),
        commit: (_task, _worktree, _patch, message) => {
          commitMessage = message
          return Promise.resolve(ok({ commitSha: 'commit-sha', baseSha: 'base-sha', artifactRef: 'artifact-ref', digest: 'patch-digest', changedFiles: 1 }))
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

    expect(commitMessage).toBe('fix: resolve issue #12')
    expect(recorded).toEqual([{
      taskId: 'issue-work-task',
      item: expect.objectContaining({
        _tag: 'Reasoning',
        text: expect.stringMatching(/malformed issue work JSON[\s\S]*ghp_\*\*\*/),
      }),
    }])
    expect(JSON.stringify(recorded)).not.toContain('ghp_Abcdefghijklmnopqrstuvwx')
    expect(result).toEqual(ok({
      _tag: 'Publish',
      usage: { _tag: 'Unavailable' },
      publication: expect.objectContaining({
        pullRequestTitle: 'fix: resolve issue #12',
        pullRequestBody: expect.stringMatching(/### Description[\s\S]*### Linked Issues[\s\S]*Closes #12\./),
      }),
    }))
  })

  it('surfaces a blocked verdict without checks as ActionRequired', async () => {
    const repository = repositoryMapping()
    const issue = issueItem()
    let committed = false
    const worker = createIssueWorkWorker({
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider([
        { _tag: 'SessionStarted', sessionId: 'session-1' },
        { _tag: 'Message', text: '{"outcome":"blocked"}' },
        { _tag: 'TurnCompleted' },
      ])),
      github: {
        getIssueTriageSnapshot: () => Promise.resolve(ok({ body: 'Reproduction', comments: [], state: 'open', title: issue.title, updatedAt: '2026-08-13T01:00:00.000Z' })),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Found', body: '### Description\n\n### Linked Issues' })),
        listPullRequestFiles: () => Promise.resolve(ok([])),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        getIssueTriageEvidence: () => null,
        getWorkerSession: (_repository, _number, _role, scopeDigest) => scopeDigest === undefined ? null : 'triage-session',
        listOpenAgentPullRequests: () => [],
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(repository)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/issue-work', headSha: 'base-sha', baseSha: 'base-sha', defaultBranchSha: 'base-sha' })),
        verify: () => Promise.reject(new Error('A blocked verdict must not be verified.')),
        restack: () => Promise.reject(new Error('A blocked verdict must not restack.')),
        commit: () => {
          committed = true
          return Promise.reject(new Error('A blocked verdict must not be committed.'))
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

    expect(committed).toBe(false)
    expect(result).toEqual(ok({
      _tag: 'ActionRequired',
      usage: { _tag: 'Unavailable' },
      reason: 'The Agent reported that it could not safely complete the issue work.',
      evidence: '{"outcome":"blocked","summary":"The Agent reported that it could not safely complete the issue work.","checks":[]}',
    }))
  })

  /** One worker whose stack decisions the caller controls. */
  function stackingWorker(input: {
    candidates: OpenAgentPullRequest[]
    pullRequestFiles?: Record<number, string[]>
    restack?: IssueWorktreeManager['restack']
  }) {
    const repository = repositoryMapping()
    const issue = issueItem()
    const bases: PullRequestBase[] = []
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
      }))),
      github: {
        getIssueTriageSnapshot: () => Promise.resolve(ok({ body: 'Reproduction', comments: [], state: 'open', title: issue.title, updatedAt: '2026-08-13T01:00:00.000Z' })),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Found', body: '### Description\n\n### Linked Issues' })),
        listPullRequestFiles: (_repository, number) => Promise.resolve(ok(input.pullRequestFiles?.[number] ?? [])),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        getIssueTriageEvidence: () => null,
        getWorkerSession: (_repository, _number, _role, scopeDigest) => scopeDigest === undefined ? null : 'triage-session',
        listOpenAgentPullRequests: () => input.candidates,
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(repository)),
      worktrees: {
        prepare: (_task, base) => {
          bases.push(base)
          return Promise.resolve(ok({ path: '/tmp/issue-work', headSha: 'base-sha', baseSha: base._tag === 'Stacked' ? base.headSha : 'base-sha', defaultBranchSha: 'base-sha' }))
        },
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 1, changedPaths: ['src/parser.ts'] })),
        restack: input.restack ?? (() => Promise.reject(new Error('Issue work must not restack.'))),
        commit: (_task, worktree, patch) => Promise.resolve(ok({
          commitSha: 'commit-sha',
          baseSha: worktree.baseSha,
          artifactRef: 'artifact-ref',
          digest: patch.digest,
          changedFiles: patch.changedFiles,
        })),
      },
    })
    const run = () => worker.run({
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
    return { bases, run }
  }

  const openRepair: OpenAgentPullRequest = {
    pullRequestNumber: 102,
    headRef: 'fix/baseline-ci-70a5f7bd49f2',
    headSha: 'repair-head',
    baseRef: 'main',
    taskKind: 'baseline_repair',
  }

  it('stacks on an open Baseline repair, because the default branch is broken', async () => {
    const { bases, run } = stackingWorker({ candidates: [openRepair] })

    const result = await run()

    expect(bases).toEqual([{ _tag: 'Stacked', ref: 'fix/baseline-ci-70a5f7bd49f2', pullRequestNumber: 102, headSha: 'repair-head' }])
    expect(result).toEqual(ok({
      _tag: 'Publish',
      usage: { _tag: 'Unavailable' },
      publication: expect.objectContaining({
        baseRef: 'fix/baseline-ci-70a5f7bd49f2',
        baseSha: 'repair-head',
        expectedHeadSha: 'repair-head',
      }),
    }))
  })

  it('stacks on an open pull request that changes the same file', async () => {
    const overlapping: OpenAgentPullRequest = {
      pullRequestNumber: 55,
      headRef: 'fix/issue-9',
      headSha: 'issue-head',
      baseRef: 'main',
      taskKind: 'issue_work',
    }
    const { bases, run } = stackingWorker({
      candidates: [overlapping],
      pullRequestFiles: { 55: ['src/parser.ts'] },
      restack: (_task, worktree, target) => Promise.resolve(ok({
        _tag: 'Restacked',
        workspace: { ...worktree, baseSha: target.headSha, headSha: target.headSha },
        patch: { digest: 'restacked-digest', changedFiles: 1, changedPaths: ['src/parser.ts'] },
      })),
    })

    const result = await run()

    expect(bases).toEqual([{ _tag: 'DefaultBranch', ref: 'main' }])
    expect(result).toEqual(ok({
      _tag: 'Publish',
      usage: { _tag: 'Unavailable' },
      publication: expect.objectContaining({
        baseRef: 'fix/issue-9',
        baseSha: 'issue-head',
        patchDigest: 'restacked-digest',
      }),
    }))
  })

  it('keeps the default branch when the stack base conflicts', async () => {
    const overlapping: OpenAgentPullRequest = {
      pullRequestNumber: 55,
      headRef: 'fix/issue-9',
      headSha: 'issue-head',
      baseRef: 'main',
      taskKind: 'issue_work',
    }
    const { run } = stackingWorker({
      candidates: [overlapping],
      pullRequestFiles: { 55: ['src/parser.ts'] },
      restack: () => Promise.resolve(ok({ _tag: 'Unstacked', reason: 'The stack base conflicts with this change.' })),
    })

    const result = await run()

    expect(result).toEqual(ok({
      _tag: 'Publish',
      usage: { _tag: 'Unavailable' },
      publication: expect.objectContaining({
        baseRef: 'main',
        baseSha: 'base-sha',
        patchDigest: 'patch-digest',
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
        listPullRequestFiles: () => Promise.resolve(ok([])),
      },
      now: () => new Date('2026-08-13T01:06:00.000Z'),
      store: {
        getIssueTriageEvidence: () => null,
        getWorkerSession: () => null,
        listOpenAgentPullRequests: () => [],
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(repository)),
      worktrees: {
        prepare: () => {
          workspaceCreated = true
          return Promise.resolve(ok({ path: '/tmp/issue-work', headSha: 'base-sha', baseSha: 'base-sha', defaultBranchSha: 'base-sha' }))
        },
        restack: () => Promise.reject(new Error('Issue work must not restack.')),
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
  it('keeps the triage session when only the default branch moves', async () => {
    const repository = repositoryMapping()
    const issue = issueItem()
    // The issue itself never changed. Only the default branch tip advanced
    // between the triage turn and this Batch unit claiming its Task.
    const snapshot = { body: 'Body', comments: [], state: 'open' as const, title: issue.title, updatedAt: '2026-08-13T01:00:00.000Z' }
    const triageDigest = issueSnapshotDigest(snapshot)
    const asked: Array<string | undefined> = []
    const worker = createIssueWorkWorker({
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        outcome: 'implemented',
        summary: 'Fixed.',
        checks: ['pnpm test'],
        commitMessage: 'fix: helper',
        pullRequestTitle: 'fix: helper',
        pullRequestBody: '### Description\n\nFixed.\n\n### Linked Issues\n\nCloses #12.',
      }))),
      github: {
        getIssueTriageSnapshot: () => Promise.resolve(ok(snapshot)),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Found', body: '### Description\n\n### Linked Issues' })),
        listPullRequestFiles: () => Promise.resolve(ok([])),
      },
      now: () => new Date('2026-08-13T01:06:00.000Z'),
      store: {
        getIssueTriageEvidence: () => null,
        getWorkerSession: (_repository, _itemNumber, _role, scopeDigest) => {
          asked.push(scopeDigest)
          return scopeDigest === triageDigest ? 'triage-session' : null
        },
        listOpenAgentPullRequests: () => [],
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(repository)),
      worktrees: {
        // Triage ran on `main-sha-1`. This worktree stands on `main-sha-2`.
        prepare: () => Promise.resolve(ok({ path: '/tmp/issue-work', headSha: 'main-sha-2', baseSha: 'main-sha-2', defaultBranchSha: 'main-sha-2' })),
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 1, changedPaths: ['src/helper.ts'] })),
        restack: () => Promise.reject(new Error('Issue work must not restack.')),
        commit: () => Promise.resolve(ok({ commitSha: 'commit-sha', baseSha: 'main-sha-2', artifactRef: 'artifact-ref', digest: 'patch-digest', changedFiles: 1 })),
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

    expect(new Set(asked)).toEqual(new Set([triageDigest]))
    if (result._tag !== 'Ok' || result.value._tag !== 'Publish' || result.value.publication._tag !== 'OpenPullRequest')
      throw new Error('Expected a pull request publication.')
  })
})

describe('issue work pull request metadata', () => {
  function runIssueWork(input: { texts: string[], template: PullRequestTemplate }) {
    const repository = repositoryMapping()
    const issue = issueItem()
    const capture: ProviderCapture = { requests: [] }
    const recorded: unknown[] = []
    const provider: AgentProvider = {
      name: 'codex',
      runTurn: (request) => {
        capture.requests.push(request)
        const text = input.texts[capture.requests.length - 1] ?? input.texts[input.texts.length - 1] ?? ''
        return (async function* () {
          yield { _tag: 'SessionStarted', sessionId: 'session-1' } as AgentEvent
          yield { _tag: 'Message', text } as AgentEvent
          yield { _tag: 'TurnCompleted' } as AgentEvent
        })()
      },
    }
    const worker = createIssueWorkWorker({
      activityLog: { record: (_taskId, item) => recorded.push(item) },
      runtime: agentRuntime(CODEX_AGENT_PROFILE, provider),
      github: {
        getIssueTriageSnapshot: () => Promise.resolve(ok({ body: 'Reproduction', comments: [], state: 'open', title: issue.title, updatedAt: '2026-08-13T01:00:00.000Z' })),
        getPullRequestTemplate: () => Promise.resolve(ok(input.template)),
        listPullRequestFiles: () => Promise.resolve(ok([])),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        getIssueTriageEvidence: () => null,
        getWorkerSession: (_repository, _number, _role, scopeDigest) => scopeDigest === undefined ? null : 'triage-session',
        listOpenAgentPullRequests: () => [],
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(repository)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/issue-work', headSha: 'base-sha', baseSha: 'base-sha', defaultBranchSha: 'base-sha' })),
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 1, changedPaths: ['src/parser.ts'] })),
        restack: () => Promise.reject(new Error('Issue work must not restack without a stack base.')),
        commit: () => Promise.resolve(ok({ commitSha: 'commit-sha', baseSha: 'base-sha', artifactRef: 'artifact-ref', digest: 'patch-digest', changedFiles: 1 })),
      },
    })
    return worker.run({
      id: 'issue-work-task',
      kind: 'issue_work',
      repository: repository.github,
      issueNumber: issue.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T01:10:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: repository,
      issue,
    }, new AbortController().signal).then(result => ({ result, capture, recorded }))
  }

  const title = 'fix(parser): keep the trailing byte of a chunked body'
  const answer = (overrides: Record<string, unknown>) => JSON.stringify({
    outcome: 'implemented',
    summary: 'Kept the trailing byte.',
    checks: ['pnpm vitest run test/parser.test.ts'],
    commitMessage: title,
    pullRequestTitle: title,
    pullRequestBody: '### Description\n\nThe parser dropped the last byte.\n\n### Linked Issues\n\nCloses #12.',
    ...overrides,
  })
  const template = { _tag: 'Found' as const, body: '### Description\n\n### Linked Issues' }

  it('publishes the Agent title when prose precedes its JSON', async () => {
    const { result, capture } = await runIssueWork({ texts: [`All green. Final result:\n\n${answer({})}`], template })

    expect(capture.requests).toHaveLength(1)
    expect(result).toEqual(ok(expect.objectContaining({
      publication: expect.objectContaining({ pullRequestTitle: title }),
    })))
  })

  it('shows a repository without a template the default one and accepts a body that follows it', async () => {
    const body = [
      '### 🔗 Linked issue',
      '',
      'Closes #12.',
      '',
      '### ❓ Type of change',
      '',
      '- [ ] 📖 Documentation',
      '- [x] 🐞 Bug fix',
      '- [ ] 👌 Enhancement',
      '- [ ] ✨ New feature',
      '- [ ] 🧹 Chore',
      '- [ ] ⚠️ Breaking change',
      '',
      '### 📚 Description',
      '',
      'The parser dropped the last byte.',
    ].join('\n')
    const { result, capture } = await runIssueWork({ texts: [answer({ pullRequestBody: body })], template: { _tag: 'Missing' } })

    expect(capture.requests).toHaveLength(1)
    expect(capture.requests[0]?.prompt).toContain('### 🔗 Linked issue')
    expect(capture.requests[0]?.prompt).not.toContain('"_tag":"Missing"')
    expect(result).toEqual(ok(expect.objectContaining({
      publication: expect.objectContaining({
        pullRequestTitle: title,
        pullRequestBody: expect.stringContaining('- [x] 🐞 Bug fix'),
      }),
    })))
  })

  it('keeps the Agent title when only its body still breaks a rule after the repair turn', async () => {
    const { result, capture, recorded } = await runIssueWork({ texts: [answer({ pullRequestBody: '## Description\n\nCloses #12.' })], template })

    expect(capture.requests).toHaveLength(2)
    expect(capture.requests[1]?.prompt).toContain('the body drops part of the repository pull request template')
    expect(JSON.stringify(recorded)).toContain('the body drops part of the repository pull request template')
    expect(result).toEqual(ok(expect.objectContaining({
      publication: expect.objectContaining({
        pullRequestTitle: title,
        pullRequestBody: expect.stringMatching(/### Description[\s\S]*### Linked Issues[\s\S]*Closes #12\./),
      }),
    })))
  })
})

describe('issue work pull request diagram', () => {
  const temporaryDirectories: string[] = []
  afterEach(() => {
    temporaryDirectories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
  })

  function runIssueWork(input: { graph?: string, graphAsDirectory?: boolean }) {
    const worktree = mkdtempSync(join(tmpdir(), 'harlan-issue-diagram-'))
    temporaryDirectories.push(worktree)
    if (input.graphAsDirectory === true)
      mkdirSync(join(worktree, '.pr-lens', 'graph.json'), { recursive: true })
    if (input.graph !== undefined) {
      mkdirSync(join(worktree, '.pr-lens'))
      writeFileSync(join(worktree, '.pr-lens', 'graph.json'), input.graph)
    }
    const repository = repositoryMapping()
    const issue = issueItem()
    const recorded: unknown[] = []
    const worker = createIssueWorkWorker({
      activityLog: { record: (_taskId, item) => recorded.push(item) },
      diagramReference: { guide: '/kit/graph-document.md', example: '/kit/example.graph.json' },
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        outcome: 'implemented',
        summary: 'Kept the trailing byte.',
        checks: ['pnpm vitest run test/parser.test.ts'],
        commitMessage: 'fix(parser): keep the trailing byte',
        pullRequestTitle: 'fix(parser): keep the trailing byte',
        pullRequestBody: '### Description\n\nThe parser dropped the last byte.\n\n### Linked Issues\n\nCloses #12.',
      }))),
      github: {
        getIssueTriageSnapshot: () => Promise.resolve(ok({ body: 'Reproduction', comments: [], state: 'open', title: issue.title, updatedAt: '2026-08-13T01:00:00.000Z' })),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Found', body: '### Description\n\n### Linked Issues' })),
        listPullRequestFiles: () => Promise.resolve(ok([])),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        getIssueTriageEvidence: () => null,
        getWorkerSession: (_repository, _number, _role, scopeDigest) => scopeDigest === undefined ? null : 'triage-session',
        listOpenAgentPullRequests: () => [],
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(repository)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: worktree, headSha: 'base-sha', baseSha: 'base-sha', defaultBranchSha: 'base-sha' })),
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 1, changedPaths: ['src/parser.ts'] })),
        restack: () => Promise.reject(new Error('Issue work must not restack without a stack base.')),
        commit: () => Promise.resolve(ok({ commitSha: 'c'.repeat(40), baseSha: 'b'.repeat(40), artifactRef: 'artifact-ref', digest: 'patch-digest', changedFiles: 1 })),
      },
    })
    return worker.run({
      id: 'issue-work-task',
      kind: 'issue_work',
      repository: repository.github,
      issueNumber: issue.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T01:10:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: repository,
      issue,
    }, new AbortController().signal).then(result => ({ result, recorded }))
  }

  const graph = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    kind: 'graph',
    title: 'Trailing byte',
    summary: 'The parser keeps the last byte of a chunked body.',
    lenses: ['architecture'],
    provenance: { repo: { owner: 'x', name: 'y' }, base: { sha: 'placeholder' }, head: { sha: 'placeholder' } },
    lanes: [{ id: 'lib', label: 'Library', order: 1 }],
    nodes: [
      { id: 'parser', label: 'parser', kind: 'module', delta: 'modified', lane: 'lib' },
      { id: 'caller', label: 'request reader', kind: 'function', delta: 'unchanged', lane: 'lib' },
    ],
    edges: [{ id: 'caller-parser', from: 'caller', to: 'parser', kind: 'call', delta: 'unchanged', emphasis: 'hero' }],
    flows: [],
    stats: {},
    views: [],
  })

  it('carries the drawn document on the publication and shows the Agent the reference', async () => {
    const { result } = await runIssueWork({ graph })

    expect(result).toEqual(ok(expect.objectContaining({
      publication: expect.objectContaining({
        diagram: { svg: expect.stringMatching(/^<svg/), alt: 'The parser keeps the last byte of a chunked body.' },
      }),
    })))
  })

  it('publishes without a picture when the worktree has no document', async () => {
    const { result, recorded } = await runIssueWork({})

    expect(result).toEqual(ok(expect.objectContaining({ publication: expect.objectContaining({ diagram: null }) })))
    expect(JSON.stringify(recorded)).not.toContain('The pull request diagram')
  })

  it('logs why a document was not drawn and still publishes', async () => {
    const { result, recorded } = await runIssueWork({ graph: '{"kind":"graph"}' })

    expect(result).toEqual(ok(expect.objectContaining({ publication: expect.objectContaining({ diagram: null }) })))
    expect(JSON.stringify(recorded)).toContain('The pull request diagram was not drawn:')
  })

  it('logs why an unreadable document was not drawn and still publishes', async () => {
    const { result, recorded } = await runIssueWork({ graphAsDirectory: true })

    expect(result).toEqual(ok(expect.objectContaining({ publication: expect.objectContaining({ diagram: null }) })))
    expect(JSON.stringify(recorded)).toContain('The pull request diagram was not drawn: the document could not be read:')
  })

  it('logs why an unrenderable document was not drawn and still publishes', async () => {
    const unrenderable = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      kind: 'graph',
      title: 'Trailing byte',
      summary: 'The parser keeps the last byte of a chunked body.',
      lenses: ['data-flow'],
      provenance: { repo: { owner: 'x', name: 'y' }, base: { sha: 'placeholder' }, head: { sha: 'placeholder' } },
      lanes: [{ id: 'lib', label: 'Library', order: 1 }],
      nodes: [
        { id: 'parser', label: 'parser', kind: 'module', delta: 'modified', lane: 'lib' },
        { id: 'caller', label: 'request reader', kind: 'function', delta: 'unchanged', lane: 'lib' },
      ],
      edges: [{ id: 'caller-parser', from: 'caller', to: 'parser', kind: 'call', delta: 'unchanged', emphasis: 'hero' }],
      flows: [],
      stats: {},
      views: [{ id: 'data-flow', title: 'Data flow', lens: 'data-flow', summary: 'How data moves.', defaultOpen: true }],
    })
    const { result, recorded } = await runIssueWork({ graph: unrenderable })

    expect(result).toEqual(ok(expect.objectContaining({ publication: expect.objectContaining({ diagram: null }) })))
    expect(JSON.stringify(recorded)).toContain('The pull request diagram was not drawn: the document could not be drawn:')
  })
})
