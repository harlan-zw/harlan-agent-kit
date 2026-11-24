import type { ProviderCapture } from './fixtures.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE, OPENCODE_AGENT_PROFILE } from '../src/agent-profile.ts'
import { conflictResolutionPrompt, createConflictWorker } from '../src/conflict-worker.ts'
import { err, ok } from '../src/result.ts'
import { parseConflictMergeWithFailingChecks } from '../src/worktree.ts'
import { agentRuntime, agentTurnLedger, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

const resolved = {
  outcome: 'resolved',
  summary: 'Resolved.',
  checks: [{ command: 'pnpm test', outcome: 'passed', details: 'All tests passed.' }],
  commitMessage: 'merge: reconcile parser changes',
  unavailableCheck: { command: '', error: '' },
  failures: [],
}

it('supplies conflict intent instead of asking a public-only CLI for private metadata', () => {
  const task = conflictTask(repositoryMapping(), { ...pullRequestItem(), title: 'Preserve parser ordering', body: 'Keep the new ordering while merging configuration.' })
  const prompt = conflictResolutionPrompt(task, { path: '/tmp/conflict', conflictedFiles: ['src/parser.ts'], writablePaths: ['src/parser.ts'], headSha: task.pullRequest.headSha, baseSha: task.pullRequest.baseSha })
  expect(prompt).toContain('Preserve parser ordering')
  expect(prompt).toContain('Keep the new ordering while merging configuration.')
  expect(prompt).toContain('public reads only')
})

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
    github: { getPullRequest: () => Promise.resolve(ok(current)), isBranchProtected: () => Promise.resolve(ok(false)) },
    now: () => new Date('2026-08-13T01:00:00.000Z'),
    store: {
      getWorkerSession: () => 'stale-session',
      saveWorkerSession: () => undefined,
      ...agentTurnLedger,
      updateAgentProgress: () => true,
    },
    validateMapping: () => Promise.resolve(ok(repository)),
    worktrees: {
      prepare: () => Promise.resolve(ok({ _tag: 'Conflicted' as const, worktree: { path: '/tmp/worktree', headSha: current.headSha, baseSha: current.baseSha, conflictedFiles: ['file.ts'], writablePaths: ['file.ts'] } })),
      verify: () => Promise.resolve(ok({ digest: 'digest', changedFiles: 1 })),
      commit: () => Promise.resolve(ok({ commitSha: 'commit', baseSha: current.baseSha, artifactRef: 'artifact', digest: 'digest', changedFiles: 1 })),
    },
  }
}

describe('conflict worker', () => {
  it.each([
    ['Required pnpm test could not start because generated types are missing'],
    [{ command: 'pnpm test', outcome: 'unavailable', details: 'Generated types are missing' }],
    [{ command: 'pnpm test', outcome: 'failed', details: 'Assertion failed' }],
    [{ command: 'pnpm test', details: 'Missing outcome' }],
    [{ command: 'pnpm test', outcome: 'skipped', details: 'Skipped' }],
    [{ command: '', outcome: 'passed', details: 'No command' }],
    [],
    [
      { command: 'pnpm lint', outcome: 'passed', details: 'Passed' },
      { command: 'pnpm test', outcome: 'unavailable', details: 'Generated types are missing' },
    ],
  ])('stops before verification or commit when resolved lacks passing check reports: %j', async (...checks) => {
    const repository = repositoryMapping()
    const current = pullRequestItem()
    const options = conflictWorkerOptions(repository, current)
    const attempts: string[] = []
    const worker = createConflictWorker({
      ...options,
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        ...resolved,
        checks,
      }))),
      worktrees: {
        ...options.worktrees,
        verify: () => {
          attempts.push('verify')
          return options.worktrees.verify()
        },
        commit: () => {
          attempts.push('commit')
          return options.worktrees.commit()
        },
      },
    })

    const result = await worker.run(conflictTask(repository, current), new AbortController().signal)

    expect(result).toEqual(err('The agent returned an invalid conflict resolution result.'))
    expect(attempts).toEqual([])
  })

  it.each([
    ['an unapproved prefix', {}, { headRef: 'v4/core-experiment' }, /v4\/core-experiment does not start with/],
    ['the default branch', {}, { headRef: 'main' }, /default branch main/],
    ['an external repository', { ownership: 'external' as const }, {}, /does not write to harlan-zw\/example/],
    ['disabled conflict resolution', { conflictResolution: false }, {}, /Conflict resolution is off for harlan-zw\/example/],
    ['an untrusted same-repository author', {}, { author: 'contributor' }, /contributor is not a writable pull request author/],
  ])('does not prepare or run conflict work for %s', async (_name, mapping, snapshot, reason) => {
    const repository = repositoryMapping(mapping)
    const current = pullRequestItem(snapshot)
    const capture: ProviderCapture = { requests: [] }
    const options = conflictWorkerOptions(repository, current)
    let prepared = false
    const worker = createConflictWorker({
      ...options,
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents(resolved), capture)),
      worktrees: { ...options.worktrees, prepare: () => {
        prepared = true
        return options.worktrees.prepare()
      } },
    })

    expect(await worker.run(conflictTask(repository, current), new AbortController().signal)).toEqual(ok({
      _tag: 'ActionRequired',
      reason: expect.stringMatching(reason),
      evidence: expect.any(String),
    }))
    expect(prepared).toBe(false)
    expect(capture.requests).toEqual([])
  })

  it('does not run conflict work for a protected head branch', async () => {
    const repository = repositoryMapping()
    const current = pullRequestItem()
    const capture: ProviderCapture = { requests: [] }
    const options = conflictWorkerOptions(repository, current)
    const worker = createConflictWorker({
      ...options,
      github: { ...options.github, isBranchProtected: () => Promise.resolve(ok(true)) },
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents(resolved), capture)),
    })
    expect(await worker.run(conflictTask(repository, current), new AbortController().signal)).toEqual(ok({
      _tag: 'ActionRequired',
      reason: 'Branch fix/broken-thing is protected. Merge main into it by hand.',
      evidence: expect.any(String),
    }))
    expect(capture.requests).toEqual([])
  })

  it('propagates a failed protection read before running conflict work', async () => {
    const repository = repositoryMapping()
    const current = pullRequestItem()
    const capture: ProviderCapture = { requests: [] }
    const options = conflictWorkerOptions(repository, current)
    const worker = createConflictWorker({
      ...options,
      github: { ...options.github, isBranchProtected: () => Promise.resolve(err({ repository: repository.github, message: 'GitHub unavailable' })) },
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents(resolved), capture)),
    })
    expect(await worker.run(conflictTask(repository, current), new AbortController().signal)).toEqual(err('GitHub unavailable'))
    expect(capture.requests).toEqual([])
  })

  it('blocks committing when branch authority is revoked during conflict work', async () => {
    const repository = repositoryMapping()
    const current = pullRequestItem()
    const capture: ProviderCapture = { requests: [] }
    const options = conflictWorkerOptions(repository, current)
    let validations = 0
    let committed = false
    const worker = createConflictWorker({
      ...options,
      validateMapping: () => Promise.resolve(ok(++validations === 1 ? repository : { ...repository, writablePullRequestHeadPrefixes: ['feat/'] })),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents(resolved), capture)),
      worktrees: { ...options.worktrees, commit: () => {
        committed = true
        return options.worktrees.commit()
      } },
    })

    expect(await worker.run(conflictTask(repository, current), new AbortController().signal)).toEqual(ok({
      _tag: 'ActionRequired',
      reason: expect.stringContaining('fix/broken-thing does not start with feat/.'),
      evidence: expect.any(String),
      usage: expect.anything(),
    }))
    expect(capture.requests).toHaveLength(1)
    expect(committed).toBe(false)
  })

  it('requires base evidence for an unchanged consumer failure and keeps an unstartable check apart', () => {
    const task = conflictTask()
    const prompt = conflictResolutionPrompt(task, { path: '/tmp/conflict-prompt', conflictedFiles: ['src/producer.ts'], writablePaths: ['src/producer.ts'], headSha: task.pullRequest.headSha, baseSha: task.pullRequest.baseSha })

    expect(prompt).toMatch(/matching base evidence.*pre-existing/)
    expect(prompt).toMatch(/Otherwise, report its cause as unknown/)
    expect(prompt).not.toMatch(/A failure in a file that neither side of the merge changed is pre-existing/)
    expect(prompt).toMatch(/cannot start.*outcome checks_unavailable/)
    expect(prompt).not.toMatch(/If setup fails.*outcome blocked/)
  })

  it('keeps an unchecked head from reaching Review when no replacement verification is proven', async () => {
    const repository = repositoryMapping()
    const current = pullRequestItem({ baseSha: 'current-base' })
    const options = conflictWorkerOptions(repository, current)
    let message = ''
    const worker = createConflictWorker({
      ...options,
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        ...resolved,
        outcome: 'checks_unavailable',
        unavailableCheck: { command: 'pnpm vitest run test/gsc.test.ts', error: 'Cannot find modules/dataforseo/.nuxt/tsconfig.app.json.' },
      }))),
      worktrees: { ...options.worktrees, commit: (_task, _worktree, _patch, value) => {
        message = value
        return options.worktrees.commit()
      } },
    })

    const result = await worker.run(conflictTask(repository, current), new AbortController().signal)

    expect(result).toEqual(ok(expect.objectContaining({ _tag: 'ActionRequired' })))
    expect(message).toBe('')
  })

  it('does not commit when a prerequisite build found a code failure before tests could start', async () => {
    const repository = repositoryMapping()
    const current = pullRequestItem()
    const options = conflictWorkerOptions(repository, current)
    let committed = false
    const worker = createConflictWorker({
      ...options,
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        ...resolved,
        outcome: 'checks_unavailable',
        checks: [{ command: 'pnpm build', outcome: 'failed', details: 'src/outside-scope.ts TS2322: Type string is not assignable to number' }],
        unavailableCheck: { command: 'pnpm test', error: 'Cannot import dist/index.mjs because pnpm build failed' },
      }))),
      worktrees: { ...options.worktrees, commit: () => {
        committed = true
        return options.worktrees.commit()
      } },
    })

    expect(await worker.run(conflictTask(repository, current), new AbortController().signal))
      .toEqual(ok(expect.objectContaining({ _tag: 'ActionRequired' })))
    expect(committed).toBe(false)
  })

  it.each([
    { command: 'pnpm test', error: 'Required check could not start: generated output missing' },
    { command: 'pnpm test', error: '' },
    { command: '', error: 'Required check could not start: generated output missing' },
  ])('rejects a resolved result with unavailable-check details before verification or commit: %o', async (unavailableCheck) => {
    const repository = repositoryMapping()
    const current = pullRequestItem()
    const options = conflictWorkerOptions(repository, current)
    const attempts: string[] = []
    const worker = createConflictWorker({
      ...options,
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({ ...resolved, unavailableCheck }))),
      worktrees: {
        ...options.worktrees,
        verify: () => {
          attempts.push('verify')
          return options.worktrees.verify()
        },
        commit: () => {
          attempts.push('commit')
          return options.worktrees.commit()
        },
      },
    })

    const result = await worker.run(conflictTask(repository, current), new AbortController().signal)

    expect(result).toEqual(err('The agent returned an invalid conflict resolution result.'))
    expect(attempts).toEqual([])
  })

  it.each(['same-repository', 'fork', 'blocked', 'resolved'] as const)(
    'redacts diagnostics before truncation, returned evidence, status text, or commits for %s',
    async (surface) => {
      const repository = repositoryMapping()
      const current = pullRequestItem(surface === 'fork'
        ? { author: 'contributor', headRepository: 'contributor/example', maintainerCanModify: true }
        : {})
      const options = conflictWorkerOptions(repository, current)
      const token = 'syntheticCredentialForRegressionOnly123456'
      const diagnostic = `${'x'.repeat(220)} Bearer ${token}: generated output missing`
      let message = ''
      const worker = createConflictWorker({
        ...options,
        runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
          outcome: surface === 'resolved' || surface === 'blocked' ? surface : 'checks_unavailable',
          summary: diagnostic,
          checks: [{ command: diagnostic, outcome: surface === 'resolved' ? 'passed' : 'unavailable', details: diagnostic }],
          commitMessage: `fix: setup Bearer ${token}`,
          unavailableCheck: surface === 'resolved' ? { command: '', error: '' } : { command: diagnostic, error: diagnostic },
          failures: [],
        }))),
        worktrees: { ...options.worktrees, commit: (_task, _worktree, _patch, value) => {
          message = value
          return options.worktrees.commit()
        } },
      })

      const result = await worker.run(conflictTask(repository, current), new AbortController().signal)
      const exposed = `${JSON.stringify(result)} ${message}`
      expect(exposed.includes(token)).toBe(false)
      expect(exposed.includes(token.slice(0, 10))).toBe(false)
      expect(exposed.includes('Bearer ***')).toBe(true)
      if (surface === 'resolved') {
        expect(result).toEqual(ok(expect.objectContaining({ _tag: 'Publish' })))
      }
      else {
        expect(result).toEqual(ok(expect.objectContaining({ _tag: 'ActionRequired' })))
        expect(message).toBe('')
        if (result._tag === 'Ok' && result.value._tag === 'ActionRequired') {
          const evidence = JSON.parse(result.value.evidence ?? '{}')
          expect(evidence.checks).toEqual([{
            command: `${'x'.repeat(220)} Bearer ***: generated output missing`,
            outcome: 'unavailable',
            details: `${'x'.repeat(220)} Bearer ***: generated output missing`,
          }])
          if (surface !== 'blocked') {
            expect(evidence.command).toBe(`${'x'.repeat(220)} Bearer ***: generated`.slice(0, 240))
            expect(evidence.error).toBe(evidence.command)
          }
        }
      }
    },
  )

  it.each([
    ['a branch in the repository', {}, 'fix/broken-thing'],
    ['a contributor fork', { author: 'contributor', headRepository: 'contributor/example', maintainerCanModify: true }, 'contributor/example:fix/broken-thing'],
  ])('names the check that could not start on %s and never commits', async (_name, head, branch) => {
    const repository = repositoryMapping()
    const current = pullRequestItem({ baseSha: 'current-base', ...head })
    const options = conflictWorkerOptions(repository, current)
    let committed = false
    const worker = createConflictWorker({
      ...options,
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        ...resolved,
        outcome: 'checks_unavailable',
        unavailableCheck: { command: 'cargo test', error: 'cargo: command not found' },
      }))),
      worktrees: { ...options.worktrees, commit: () => {
        committed = true
        return options.worktrees.commit()
      } },
    })

    const result = await worker.run(conflictTask(repository, current), new AbortController().signal)

    expect(result).toEqual(ok(expect.objectContaining({
      _tag: 'ActionRequired',
      reason: 'The agent resolved the merge conflict, but cargo test could not start: cargo: command not found. '
        + `The Service does not push a merge whose required check did not run. Merge main into ${branch} by hand.`,
    })))
    expect(committed).toBe(false)
  })

  it.each([
    { command: '', error: 'missing' },
    { command: 'pnpm vitest run', error: ' ' },
  ])('rejects an unavailable check without its exact command and error: %o', async (unavailableCheck) => {
    const repository = repositoryMapping()
    const current = pullRequestItem({ baseSha: 'current-base' })
    const worker = createConflictWorker({
      ...conflictWorkerOptions(repository, current),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({ ...resolved, outcome: 'checks_unavailable', unavailableCheck }))),
    })

    expect(await worker.run(conflictTask(repository, current), new AbortController().signal))
      .toEqual(err('The agent returned checks_unavailable without the exact command and error.'))
  })

  it.each(['null', '[]', '"resolved"'])('rejects a non-object Agent response %s as invalid', async (response) => {
    const repository = repositoryMapping()
    const current = pullRequestItem({ baseSha: 'current-base' })
    const worker = createConflictWorker({
      ...conflictWorkerOptions(repository, current),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider([
        { _tag: 'SessionStarted', sessionId: 'session-1' },
        { _tag: 'Message', text: response },
        { _tag: 'TurnCompleted' },
      ])),
    })

    expect(await worker.run(conflictTask(repository, current), new AbortController().signal))
      .toEqual(err('The agent returned an invalid conflict resolution result.'))
  })

  it('stops a blocked resolution with one exact step', async () => {
    const repository = repositoryMapping()
    const current = pullRequestItem({ baseSha: 'current-base' })
    const worker = createConflictWorker({
      ...conflictWorkerOptions(repository, current),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        ...resolved,
        outcome: 'blocked',
        summary: 'Both branches add ADR-0023, and renumbering one needs paths outside the merge',
        commitMessage: '',
      }))),
    })

    expect(await worker.run(conflictTask(repository, current), new AbortController().signal)).toEqual(ok(expect.objectContaining({
      _tag: 'ActionRequired',
      reason: 'Both branches add ADR-0023, and renumbering one needs paths outside the merge. Merge main into fix/broken-thing by hand.',
    })))
  })

  it('completes a clean merge without an agent turn and asks GitHub to recompute once', async () => {
    const repository = repositoryMapping()
    const current = pullRequestItem({ baseSha: 'current-base' })
    const capture: ProviderCapture = { requests: [] }
    let reads = 0
    const options = conflictWorkerOptions(repository, current)
    const worker = createConflictWorker({
      ...options,
      github: { ...options.github, getPullRequest: () => {
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
          return Promise.resolve(ok({ _tag: 'Conflicted' as const, worktree: { path: '/tmp/worktree', headSha: current.headSha, baseSha: current.baseSha, conflictedFiles: ['file.ts'], writablePaths: ['file.ts'] } }))
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
        prepare: () => Promise.resolve(ok({ _tag: 'Conflicted' as const, worktree: { path: '/tmp/worktree', headSha: 'head-sha', baseSha: 'current-base', conflictedFiles: ['src/a.ts', 'src/b.vue'], writablePaths: ['src/a.ts', 'src/b.vue'] } })),
      },
    })

    const result = await worker.run(conflictTask(repository, current), new AbortController().signal)

    expect(result._tag).toBe('Ok')
    const prompt = capture.requests[0]?.prompt ?? ''
    expect(prompt).toContain('Pull request head: head-sha')
    expect(prompt).toContain('Base branch: feat/parent at current-base')
    expect(prompt).toContain('- src/a.ts\n- src/b.vue')
    expect(prompt).toContain('Check budget: run eslint on the conflicted files, vitest on the test files that import them, and git diff --check.')
    expect(prompt).toContain('Do not run the full test suite, the full typecheck, or a build.')
    expect(prompt).toContain('Do not install or update the toolchain.')
    expect(prompt).toContain('Never use npx.')
    expect(prompt).toContain('Leave no conflict markers in any file.')
    expect(prompt).not.toContain('unit-tests skill')
  })
})

describe('conflict worker with a failing check outside the merge', () => {
  const renderCheck = 'pnpm vitest run test/render.test.ts'
  const withFailures = {
    ...resolved,
    outcome: 'resolved_with_failures',
    summary: 'Merged. A test outside the merge still imports the removed helper.',
    checks: [
      { command: 'pnpm vitest run test/parser.test.ts', outcome: 'passed', details: 'Passed.' },
      { command: renderCheck, outcome: 'failed', details: 'test/render.test.ts:41 imports a removed export.' },
    ],
    failures: [{ command: renderCheck, paths: ['test/render.test.ts:41', './src/render.ts'] }],
  }

  async function run(response: unknown) {
    const repository = repositoryMapping()
    const current = pullRequestItem({ baseSha: 'current-base' })
    const options = conflictWorkerOptions(repository, current)
    const attempts: string[] = []
    const worker = createConflictWorker({
      ...options,
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents(response))),
      worktrees: {
        ...options.worktrees,
        prepare: () => Promise.resolve(ok({ _tag: 'Conflicted' as const, worktree: { path: '/tmp/worktree', headSha: current.headSha, baseSha: current.baseSha, conflictedFiles: ['src/parser.ts'], writablePaths: ['src/parser.ts', 'src/shared.ts'] } })),
        verify: () => {
          attempts.push('verify')
          return options.worktrees.verify()
        },
        commit: () => {
          attempts.push('commit')
          return options.worktrees.commit()
        },
      },
    })
    return { attempts, current, result: await worker.run(conflictTask(repository, current), new AbortController().signal) }
  }

  it('publishes the resolved merge and records each failing check with the paths its fix needs', async () => {
    const { attempts, current, result } = await run(withFailures)

    expect(result).toEqual(ok(expect.objectContaining({
      _tag: 'Publish',
      publication: expect.objectContaining({
        _tag: 'UpdatePullRequest',
        taskKind: 'resolve_conflict',
        commitSha: 'commit',
        expectedHeadSha: current.headSha,
        headRef: current.headRef,
      }),
    })))
    expect(attempts).toEqual(['verify', 'commit'])
    const evidence = result._tag === 'Ok' && result.value._tag === 'Publish' ? result.value.evidence ?? null : null
    expect(parseConflictMergeWithFailingChecks(evidence)).toEqual({
      _tag: 'MergedWithFailingChecks',
      commitSha: 'commit',
      baseRef: 'main',
      failures: [{ command: renderCheck, paths: ['test/render.test.ts', 'src/render.ts'] }],
    })
  })

  it('publishes a fully passing merge with no failing check evidence', async () => {
    const { result } = await run(resolved)

    expect(result).toEqual(ok(expect.objectContaining({ _tag: 'Publish' })))
    expect(result._tag === 'Ok' && result.value._tag === 'Publish' ? result.value.evidence : 'missing').toBeUndefined()
  })

  it.each([
    ['a file', 'src/shared.ts:12', 'src/shared.ts'],
    ['a directory holding a file', 'src', 'src'],
  ])('stops like blocked when a failing check needs %s the merge touched', async (_name, named, reported) => {
    const { attempts, result } = await run({
      ...withFailures,
      failures: [{ command: renderCheck, paths: ['test/render.test.ts', named] }],
    })

    expect(result).toEqual(ok(expect.objectContaining({
      _tag: 'ActionRequired',
      reason: `The agent resolved the merge conflict, but ${renderCheck} fails, and its fix needs ${reported}, which the merge changed. Merge main into fix/broken-thing by hand.`,
    })))
    expect(attempts).toEqual([])
  })

  it.each([[], [{ command: renderCheck, paths: ['test/render.test.ts'] }]])('still stops when a required check could not start beside a failing one, with failures %j', async (...failures) => {
    const { attempts, result } = await run({
      ...withFailures,
      outcome: 'checks_unavailable',
      checks: [...withFailures.checks, { command: 'pnpm typecheck', outcome: 'unavailable', details: 'tsc is missing.' }],
      failures,
      unavailableCheck: { command: 'pnpm typecheck', error: 'tsc: command not found' },
    })

    expect(result).toEqual(ok(expect.objectContaining({
      _tag: 'ActionRequired',
      reason: expect.stringContaining('pnpm typecheck could not start: tsc: command not found.'),
    })))
    expect(attempts).toEqual([])
  })

  it('keeps a blocked answer that describes a failure without its paths', async () => {
    const { attempts, result } = await run({
      ...withFailures,
      outcome: 'blocked',
      summary: 'Intent is ambiguous after the merge',
      commitMessage: '',
      failures: [{ command: renderCheck, paths: [] }],
    })

    expect(result).toEqual(ok(expect.objectContaining({
      _tag: 'ActionRequired',
      reason: 'Intent is ambiguous after the merge. Merge main into fix/broken-thing by hand.',
    })))
    expect(attempts).toEqual([])
  })

  it.each([
    ['no check failed', { checks: [{ command: renderCheck, outcome: 'passed', details: 'Passed.' }] }],
    ['a check could not start', { checks: [...withFailures.checks, { command: 'pnpm typecheck', outcome: 'unavailable', details: 'tsc is missing.' }] }],
    ['an unavailable check is named', { unavailableCheck: { command: 'pnpm typecheck', error: 'tsc: command not found' } }],
    ['a failed check has no failure entry', { failures: [] }],
    ['a failure entry names a passing check', { failures: [{ command: 'pnpm vitest run test/parser.test.ts', paths: ['src/other.ts'] }] }],
    ['a failure names no path', { failures: [{ command: renderCheck, paths: [] }] }],
    ['a failure names an absolute path', { failures: [{ command: renderCheck, paths: ['/srv/checkout/test/render.test.ts'] }] }],
    ['a failure names a parent path', { failures: [{ command: renderCheck, paths: ['../render.test.ts'] }] }],
    ['the commit message is empty', { commitMessage: ' ' }],
    ['a resolved merge lists failures', { outcome: 'resolved', checks: [{ command: renderCheck, outcome: 'passed', details: 'Passed.' }] }],
  ])('rejects the result before verification or commit when %s', async (_name, change) => {
    const { attempts, result } = await run({ ...withFailures, ...change })

    expect(result).toEqual(err('The agent returned an invalid conflict resolution result.'))
    expect(attempts).toEqual([])
  })

  it('tells the agent when a failing check pushes the merge and when it blocks', () => {
    const task = conflictTask()
    const prompt = conflictResolutionPrompt(task, { path: '/tmp/conflict-prompt', conflictedFiles: ['src/producer.ts'], writablePaths: ['src/producer.ts'], headSha: task.pullRequest.headSha, baseSha: task.pullRequest.baseSha })

    expect(prompt).toMatch(/check ran and failed, and its fix needs a path outside the listed paths, return outcome resolved_with_failures/)
    expect(prompt).toMatch(/fix needs a listed path, fix it.*outcome blocked/)
    expect(prompt).toContain('relative to the repository root')
  })
})
