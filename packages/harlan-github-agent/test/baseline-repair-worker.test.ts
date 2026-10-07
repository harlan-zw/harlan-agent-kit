import type { AgentEvent } from '../src/agent-provider.ts'
import type { FailedJobContext, GitHubCheck, PullRequestTemplate } from '../src/github-agent-source.ts'
import type { Result } from '../src/result.ts'
import type { ClaimedBaselineRepairTask, GitHubPullRequestItem } from '../src/types.ts'
import type { ProviderCapture } from './fixtures.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { BASELINE_REPAIR_MARKER } from '../src/baseline-repair-state.ts'
import { createBaselineRepairWorker, workspaceFactsFromFiles } from '../src/baseline-repair-worker.ts'
import { err, ok } from '../src/result.ts'
import { agentRuntime, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

const disclosure = '> 🤖 AI disclosure: [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) modified this description. [My AI open-source policy](https://harlanzw.com/blog/ai-in-open-source).'

const repaired = {
  outcome: 'repaired',
  summary: 'Fixed the broken generated types.',
  checks: ['pnpm vitest run test/types.test.ts'],
  commitMessage: 'fix(types): regenerate runtime declarations',
  pullRequestTitle: 'fix(types): regenerate runtime declarations',
  pullRequestBody: 'The generated declarations drifted from the runtime. CI fails until they match.',
}

function actionsCheck(overrides: Partial<GitHubCheck> = {}): GitHubCheck {
  return { id: 96051144474, failure: { _tag: 'NotAsked' }, source: { _tag: 'CheckRun', appId: 15368 }, name: 'test', status: 'completed', conclusion: 'failure', ...overrides }
}

function jobContext(overrides: Partial<FailedJobContext> = {}): FailedJobContext {
  return { runId: 33466651519, jobName: 'test (24)', failedStep: 'Run pnpm test', logTail: ['FAIL test/types.test.ts', 'Tests 1 failed | 12 passed'], ...overrides }
}

interface WorkerInput {
  events?: AgentEvent[]
  capture?: ProviderCapture
  checks?: GitHubCheck[]
  finalChecks?: GitHubCheck[]
  template?: PullRequestTemplate
  templateError?: string
  openRepair?: { number: number, url: string } | null
  job?: Result<FailedJobContext, string>
  workspace?: { hasAgentsFile: boolean, nodeOptions: string | null }
  preparedHead?: string
  defaultBases?: string[]
  trigger?: Partial<GitHubPullRequestItem>
  unreadableChecks?: boolean
  onCommit?: (message: string) => void
  onActivity?: (taskId: string, item: unknown) => void
}

function baselineTask(pullRequest: GitHubPullRequestItem): ClaimedBaselineRepairTask {
  const mapping = repositoryMapping()
  return {
    id: 'baseline-task',
    kind: 'baseline_repair',
    repository: mapping.github,
    pullRequestNumber: pullRequest.number,
    revisionId: 'revision-1',
    state: { _tag: 'Running', workerId: 'baseline-agent', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
    updatedAt: '2026-08-13T01:00:00.000Z',
    repositoryMapping: mapping,
    pullRequest,
  }
}

function runWorker(input: WorkerInput = {}) {
  const pullRequest = pullRequestItem({ mergeState: 'clean', ...input.trigger })
  const defaultBases = [...(input.defaultBases ?? ['base123', 'base123'])]
  let snapshotReads = 0
  const agentStarted = { value: false }
  const events = input.events ?? turnEvents(repaired)
  const provider = stubProvider(events, input.capture)
  const worker = createBaselineRepairWorker({
    ...(input.onActivity === undefined ? {} : { activityLog: { record: input.onActivity } }),
    runtime: agentRuntime(CODEX_AGENT_PROFILE, {
      ...provider,
      runTurn: (request) => {
        agentStarted.value = true
        return provider.runTurn(request)
      },
    }),
    github: {
      findOpenPullRequestForBranch: () => Promise.resolve(ok(input.openRepair ?? null)),
      getFailedJobContext: () => Promise.resolve(input.job ?? ok(jobContext())),
      getPullRequestTemplate: () => Promise.resolve(input.templateError === undefined ? ok(input.template ?? { _tag: 'Missing' }) : err(input.templateError)),
      getDefaultBranchSnapshot: () => {
        snapshotReads += 1
        return Promise.resolve(ok({
          baseSha: defaultBases.shift() ?? 'base123',
          baseChecks: input.unreadableChecks ? { _tag: 'Unavailable', reason: 'GitHub checks unavailable' } : { _tag: 'Available', checks: (snapshotReads > 1 ? input.finalChecks : undefined) ?? input.checks ?? [actionsCheck()] },
        }))
      },
    },
    inspectWorkspace: () => Promise.resolve(input.workspace ?? { hasAgentsFile: false, nodeOptions: null }),
    now: () => new Date('2026-08-13T01:00:00.000Z'),
    store: {
      getWorkerSession: () => null,
      saveWorkerSession: () => undefined,
      updateAgentProgress: () => true,
    },
    validateMapping: value => Promise.resolve(ok(value)),
    worktrees: {
      prepare: () => Promise.resolve(ok({ path: '/tmp/baseline-worktree', baseSha: pullRequest.baseSha, headSha: input.preparedHead ?? pullRequest.baseSha })),
      verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 2 })),
      commit: (_task, _worktree, _patch, message) => {
        input.onCommit?.(message)
        return Promise.resolve(ok({ commitSha: 'repair-commit', baseSha: pullRequest.baseSha, artifactRef: 'artifact-ref', digest: 'patch-digest', changedFiles: 2 }))
      },
    },
  })
  return worker.run(baselineTask(pullRequest), new AbortController().signal).then(result => ({ result, pullRequest, agentStarted: agentStarted.value }))
}

describe('baseline repair worker', () => {
  it.each([
    { defaultBases: ['new-default'], unreadableChecks: true },
    { defaultBases: ['new-default'], templateError: 'Template unavailable.' },
    { checks: [actionsCheck({ conclusion: 'success' })], templateError: 'Template unavailable.' },
  ])('retires proven obsolete work without ancillary CI or template access: %j', async (input) => {
    let commits = 0
    const { result, agentStarted } = await runWorker({ ...input, onCommit: () => {
      commits += 1
    } })
    expect(result).toEqual(ok(expect.objectContaining({ _tag: 'Superseded' })))
    expect(agentStarted).toBe(false)
    expect(commits).toBe(0)
  })

  it.each([
    { checks: [] },
    { checks: [actionsCheck({ status: 'in_progress', conclusion: null })] },
    { checks: [actionsCheck({ status: 'queued', conclusion: 'success' })] },
    { checks: [actionsCheck({ status: 'in_progress', conclusion: 'failure' })] },
    { checks: [actionsCheck({ conclusion: 'success', failure: { _tag: 'RunnerLost', incompleteSteps: 2 } })] },
  ])('keeps unresolved initial default branch checks retryable: %j', async ({ checks }) => {
    const { result, agentStarted } = await runWorker({ checks })
    expect(result).toEqual(err('Default branch CI has not finished for this Baseline repair.'))
    expect(agentStarted).toBe(false)
  })

  it.each([
    { finalChecks: [] },
    { finalChecks: [actionsCheck({ status: 'in_progress', conclusion: null })] },
    { finalChecks: [actionsCheck({ status: 'queued', conclusion: 'success' })] },
    { finalChecks: [actionsCheck({ status: 'in_progress', conclusion: 'failure' })] },
    { finalChecks: [actionsCheck({ conclusion: 'success', failure: { _tag: 'RunnerLost', incompleteSteps: 2 } })] },
  ])('keeps unresolved final default branch checks retryable without committing: %j', async ({ finalChecks }) => {
    let commits = 0
    const { result, agentStarted } = await runWorker({ finalChecks, onCommit: () => {
      commits += 1
    } })
    expect(result).toEqual(err('Default branch CI has not finished for this Baseline repair.'))
    expect(agentStarted).toBe(true)
    expect(commits).toBe(0)
  })

  it('publishes the verified fix under the Agent title with a controller-owned body', async () => {
    let commitMessage = ''
    const { result, pullRequest } = await runWorker({
      template: { _tag: 'Found', body: '### Description\n\n### Linked Issues' },
      onCommit: (message) => { commitMessage = message },
    })

    expect(commitMessage).toBe(repaired.commitMessage)
    expect(result).toEqual(ok({
      _tag: 'Publish',
      usage: { _tag: 'Unavailable' },
      publication: expect.objectContaining({
        _tag: 'OpenPullRequest',
        taskKind: 'baseline_repair',
        expectedHeadSha: pullRequest.baseSha,
        pullRequestTitle: repaired.pullRequestTitle,
        headRef: `fix/baseline-ci-${pullRequest.baseSha.slice(0, 12)}`,
        pullRequestBody: `${BASELINE_REPAIR_MARKER}\n### Description\n\n### Linked Issues\n\n${repaired.pullRequestBody}\n\n${disclosure}`,
      }),
    }))
  })

  it('repairs the default branch after the triggering pull request retargets', async () => {
    const { result, agentStarted } = await runWorker({ trigger: { baseRef: 'feature/parent', state: 'closed' } })
    expect(agentStarted).toBe(true)
    expect(result).toEqual(ok(expect.objectContaining({ _tag: 'Publish' })))
  })

  it('retires the old failure before starting when the default branch moved', async () => {
    const { result, agentStarted } = await runWorker({ defaultBases: ['new-default'] })
    expect(agentStarted).toBe(false)
    expect(result).toEqual(ok(expect.objectContaining({ _tag: 'Superseded' })))
  })

  it('refuses to commit when the default branch moves during repair', async () => {
    let committed = false
    const { result, agentStarted } = await runWorker({ defaultBases: ['base123', 'new-default'], onCommit: () => {
      committed = true
    } })
    expect(agentStarted).toBe(true)
    expect(committed).toBe(false)
    expect(result).toEqual(err('Default branch changed before the controller committed the Baseline repair.'))
  })

  it('retires the repair when default branch CI turns green during the Agent turn', async () => {
    let committed = false
    const { result } = await runWorker({ finalChecks: [actionsCheck({ conclusion: 'success' })], onCommit: () => {
      committed = true
    } })
    expect(committed).toBe(false)
    expect(result).toEqual(ok(expect.objectContaining({ _tag: 'Superseded' })))
  })

  it('keeps unreadable default branch checks retryable', async () => {
    const { result, agentStarted } = await runWorker({ unreadableChecks: true })
    expect(agentStarted).toBe(false)
    expect(result).toEqual(err('GitHub checks unavailable'))
  })

  it('completes with the open pull request as evidence instead of repairing the same base commit again', async () => {
    const { result, agentStarted } = await runWorker({
      openRepair: { number: 176, url: 'https://github.com/harlan-zw/example/pull/176' },
    })

    expect(agentStarted).toBe(false)
    expect(result).toEqual(ok({
      _tag: 'Completed',
      evidence: 'GitHub reports Baseline repair pull request #176: https://github.com/harlan-zw/example/pull/176',
    }))
  })

  it.each([
    ['a runner kill in the log', actionsCheck({ name: 'build' }), ok(jobContext({ logTail: ['> nuxt build', '##[error]Process completed with exit code 129.'] })), /exit code 129/],
    ['a lost runner with no log', actionsCheck({ name: 'test', failure: { _tag: 'RunnerLost', incompleteSteps: 3 } }), err('Gone - https://docs.github.com/rest'), /runner lost the job/],
  ])('waits for a person when the only failure is %s', async (_name, check, job, reason) => {
    const { result, agentStarted } = await runWorker({ checks: [check], job })

    expect(agentStarted).toBe(false)
    expect(result).toEqual(ok({
      _tag: 'ActionRequired',
      reason: expect.stringMatching(reason),
      evidence: expect.stringContaining(check.name),
    }))
  })

  it('gives the Agent the run id, job, step, log tail, and the workflow NODE_OPTIONS', async () => {
    const capture: ProviderCapture = { requests: [] }
    await runWorker({
      capture,
      workspace: { hasAgentsFile: true, nodeOptions: '--max-old-space-size=8192' },
      checks: [actionsCheck({ name: 'test' })],
    })
    const prompt = capture.requests[0]?.prompt ?? ''

    expect(prompt).toContain('Run id 33466651519, job "test (24)", failed step "Run pnpm test".')
    expect(prompt).toContain('Tests 1 failed | 12 passed')
    expect(prompt).toContain('NODE_OPTIONS=--max-old-space-size=8192')
    expect(prompt).toContain('Read AGENTS.md')
    expect(prompt).toContain('Never run sudo or systemctl.')
    expect(prompt).toContain('Check budget: prefer a narrower command that reproduces the same failure')
    expect(prompt).not.toMatch(/PR skill|pull request template/i)
  })

  it.each([
    { job: err('Private job log unavailable') },
    { job: ok(jobContext({ logTail: [] })) },
    { job: ok(jobContext({ failedStep: null })) },
    { checks: [actionsCheck({ conclusion: 'cancelled' })], job: ok(jobContext({ failedStep: null, logTail: ['##[error]The operation was canceled.'] })) },
    { checks: [actionsCheck({ conclusion: 'cancelled', failure: { _tag: 'RunnerLost', incompleteSteps: 2 } })], job: err('Cancelled job log unavailable') },
    { checks: [actionsCheck({ source: { _tag: 'CommitStatus' } })] },
    { checks: [actionsCheck(), actionsCheck({ id: 2, source: { _tag: 'CommitStatus' } })] },
  ])('requires failure evidence before starting repository repair: %j', async (input) => {
    const capture: ProviderCapture = { requests: [] }
    const { result, agentStarted } = await runWorker({ ...input, capture })
    expect(result).toEqual(ok(expect.objectContaining({ _tag: 'ActionRequired', reason: expect.stringMatching(/evidence/i) })))
    expect(agentStarted).toBe(false)
    expect(capture.requests).toEqual([])
  })

  it('keeps repairable checks in scope and names infrastructure checks as out of scope', async () => {
    const capture: ProviderCapture = { requests: [] }
    const jobs = new Map<number, FailedJobContext>([
      [1, jobContext({ jobName: 'build', logTail: ['##[error]Process completed with exit code 129.'] })],
      [2, jobContext({ jobName: 'typecheck', logTail: ['error TS2322: Type \'boolean | undefined\' is not assignable'] })],
    ])
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const worker = createBaselineRepairWorker({
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents(repaired), capture)),
      github: {
        findOpenPullRequestForBranch: () => Promise.resolve(ok(null)),
        getFailedJobContext: (_repository, jobId) => Promise.resolve(ok(jobs.get(jobId) ?? jobContext())),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        getDefaultBranchSnapshot: () => Promise.resolve(ok({
          baseSha: pullRequest.baseSha,
          baseChecks: { _tag: 'Available', checks: [actionsCheck({ id: 1, name: 'build' }), actionsCheck({ id: 2, name: 'typecheck' })] },
        })),
      },
      inspectWorkspace: () => Promise.resolve({ hasAgentsFile: false, nodeOptions: null }),
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: { getWorkerSession: () => null, saveWorkerSession: () => undefined, updateAgentProgress: () => true },
      validateMapping: value => Promise.resolve(ok(value)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/baseline-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.baseSha })),
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 1 })),
        commit: () => Promise.resolve(ok({ commitSha: 'repair-commit', baseSha: pullRequest.baseSha, artifactRef: 'artifact-ref', digest: 'patch-digest', changedFiles: 1 })),
      },
    })

    const result = await worker.run(baselineTask(pullRequest), new AbortController().signal)
    const prompt = capture.requests[0]?.prompt ?? ''

    expect(result).toEqual(ok(expect.objectContaining({ _tag: 'Publish' })))
    expect(prompt).toContain('- Check "typecheck", conclusion failure.\n  Run id 33466651519, job "typecheck"')
    expect(prompt).toContain('Do not change the repository for them:\n- Check "build": The runner killed the job')
    expect(prompt).not.toContain('- Check "build", conclusion failure.')
  })

  it('publishes a verified patch with safe metadata when Agent output is malformed', async () => {
    const recorded: Array<{ taskId: string, item: unknown }> = []
    let commitMessage = ''
    const { result } = await runWorker({
      events: [
        { _tag: 'SessionStarted', sessionId: 'session-1' },
        { _tag: 'Message', text: '{ broken ghp_Abcdefghijklmnopqrstuvwx' },
        { _tag: 'TurnCompleted' },
      ],
      template: { _tag: 'Found', body: '### Description\n\n### Linked Issues' },
      onActivity: (taskId, item) => recorded.push({ taskId, item }),
      onCommit: (message) => { commitMessage = message },
    })

    expect(commitMessage).toBe('fix: repair default branch CI')
    expect(recorded).toEqual([{
      taskId: 'baseline-task',
      item: expect.objectContaining({
        _tag: 'Reasoning',
        text: expect.stringMatching(/malformed Baseline repair JSON[\s\S]*ghp_\*\*\*/),
      }),
    }])
    expect(JSON.stringify(recorded)).not.toContain('ghp_Abcdefghijklmnopqrstuvwx')
    expect(result).toEqual(ok({
      _tag: 'Publish',
      usage: { _tag: 'Unavailable' },
      publication: expect.objectContaining({
        pullRequestTitle: 'fix: repair default branch CI',
        pullRequestBody: expect.stringMatching(/### Description[\s\S]*### Linked Issues[\s\S]*Repairs failing default branch CI\./),
      }),
    }))
  })

  it('does not publish an internal missing-template value as the pull request body', async () => {
    const { result } = await runWorker({
      events: turnEvents({ ...repaired, pullRequestBody: JSON.stringify({ _tag: 'Missing' }) }),
    })

    expect(result).toEqual(ok({
      _tag: 'Publish',
      usage: { _tag: 'Unavailable' },
      publication: expect.objectContaining({
        pullRequestBody: expect.stringContaining('Repairs failing default branch CI.'),
      }),
    }))
    expect(JSON.stringify(result)).not.toContain('"_tag":"Missing"')
  })

  it('surfaces ActionRequired when a blocked result carries malformed metadata', async () => {
    const { result } = await runWorker({
      events: [
        { _tag: 'SessionStarted', sessionId: 'session-1' },
        { _tag: 'Message', text: JSON.stringify({ outcome: 'blocked' }) },
        { _tag: 'TurnCompleted' },
      ],
      onCommit: () => { throw new Error('A blocked result must not publish a patch.') },
    })

    expect(result).toEqual(ok({
      _tag: 'ActionRequired',
      usage: { _tag: 'Unavailable' },
      reason: 'The Agent reported that it could not safely repair Baseline CI.',
      evidence: expect.stringContaining('"outcome":"blocked"'),
    }))
  })

  it.each(['success', 'skipped', 'neutral'])('retires before an Agent turn after completed %s CI', async (conclusion) => {
    const { result, agentStarted } = await runWorker({ checks: [actionsCheck({ conclusion })] })
    expect(agentStarted).toBe(false)
    expect(result).toEqual(ok({ _tag: 'Superseded', reason: expect.stringContaining('Default branch CI no longer fails') }))
  })

  it('retires the repair when the prepared default branch moved past the failing commit', async () => {
    const { result, agentStarted } = await runWorker({
      preparedHead: 'f'.repeat(40),
      onCommit: () => { throw new Error('A retired repair must not commit.') },
    })

    expect(agentStarted).toBe(false)
    expect(result).toEqual(ok({ _tag: 'Superseded', reason: expect.stringContaining('The default branch moved to') }))
  })
})

describe('workspaceFactsFromFiles', () => {
  it('reads NODE_OPTIONS from the first workflow that sets it, quoted or bare', () => {
    const facts = workspaceFactsFromFiles([
      { path: '.github/workflows/lint.yml', content: 'name: lint\njobs:\n  lint:\n    runs-on: ubuntu-latest\n' },
      { path: '.github/workflows/test.yml', content: 'env:\n  NODE_OPTIONS: "--max-old-space-size=8192"\njobs: {}\n' },
      { path: '.github/workflows/build.yaml', content: 'env:\n  NODE_OPTIONS: --max-old-space-size=4096 # build\n' },
    ])
    expect(facts).toEqual({ hasAgentsFile: false, nodeOptions: '--max-old-space-size=8192' })
  })

  it('ignores NODE_OPTIONS outside the workflows directory and finds AGENTS.md', () => {
    const facts = workspaceFactsFromFiles([
      { path: 'AGENTS.md', content: '' },
      { path: 'docker-compose.yml', content: 'environment:\n  NODE_OPTIONS: --inspect\n' },
    ])
    expect(facts).toEqual({ hasAgentsFile: true, nodeOptions: null })
  })
})

describe('baseline repair metadata', () => {
  it('publishes the Agent title when prose precedes its JSON', async () => {
    const { result } = await runWorker({
      events: [
        { _tag: 'SessionStarted', sessionId: 'session-1' },
        { _tag: 'Message', text: `All checks green.\n\n${JSON.stringify(repaired)}` },
        { _tag: 'TurnCompleted' },
      ],
    })

    expect(result).toEqual(ok(expect.objectContaining({
      publication: expect.objectContaining({ pullRequestTitle: 'fix(types): regenerate runtime declarations' }),
    })))
  })
})
