import type { AgentRuntimeSource } from '../src/agent-profile.ts'
import type { AgentEvent, AgentTurnRequest } from '../src/agent-provider.ts'
import type { writeCheckinGitHubEvidence } from '../src/checkin-github-evidence.ts'
import type { GitHubIssuePublisher } from '../src/github.ts'
import type { RoutineScanInput } from '../src/routines/contract.ts'
import type { ClaimedRoutineRun } from '../src/types.ts'
import type { RoutineGitHubEvidence, RoutineGitHubEvidenceSource } from '../src/worker-github-evidence.ts'
import { describe, expect, it } from 'vitest'
import { createAgentActivityLog } from '../src/agent-activity.ts'
import { createAgentPermitPool } from '../src/agent-permit-pool.ts'
import { CODEX_AGENT_PROFILE, createAgentRuntimeSource } from '../src/agent-profile.ts'
import { ok } from '../src/result.ts'
import { createRoutineReportController } from '../src/routine-report-controller.ts'
import { createRoutineScanWorker } from '../src/routine-worker.ts'
import { getRoutine } from '../src/routines/index.ts'
import { openJournalStore } from '../src/store.ts'
import { collectRoutineGitHubEvidence } from '../src/worker-github-evidence.ts'
import { createWorkerTaskScheduler } from '../src/worker-task-scheduler.ts'
import { issueItem, repositoryMapping } from './fixtures.ts'

const routineScanPrompt = (input: RoutineScanInput) => getRoutine(input.name).scanPrompt(input)

const now = () => new Date('2026-08-27T07:05:00.000Z')

function claimStoredRun(store: ReturnType<typeof openJournalStore>, at = now().toISOString()): ClaimedRoutineRun {
  const task = store.claimNextRoutineRun('worker-1', at, 60 * 60_000)
  if (task === null)
    throw new Error('Expected a queued Routine run.')
  return task
}

function scanning(answer: unknown, capture?: { prompts: string[], requests?: AgentTurnRequest[] }) {
  return {
    name: 'codex' as const,
    runTurn: (request: AgentTurnRequest) => {
      capture?.prompts.push(request.prompt)
      capture?.requests?.push(request)
      return (async function* (): AsyncIterable<AgentEvent> {
        // Codex rejects the whole turn when an object property is not required.
        const pending: unknown[] = [request.outputSchema]
        while (pending.length > 0) {
          const schema = pending.pop()
          if (typeof schema !== 'object' || schema === null)
            continue
          const object = schema as { properties?: Record<string, unknown>, required?: string[], items?: unknown }
          for (const [key, property] of Object.entries(object.properties ?? {})) {
            if (!object.required?.includes(key)) {
              yield { _tag: 'Failed', reason: `Invalid response schema: required must include ${key}.` }
              return
            }
            pending.push(property)
          }
          if (object.items !== undefined)
            pending.push(object.items)
        }
        yield { _tag: 'SessionStarted', sessionId: 'session-1' }
        yield { _tag: 'Message', text: JSON.stringify(answer) }
        yield { _tag: 'TurnCompleted' }
      })()
    },
  }
}

function workerFor(
  store: ReturnType<typeof openJournalStore>,
  provider: ReturnType<typeof scanning>,
  maximumChangedFiles?: number,
  activityLog?: ReturnType<typeof createAgentActivityLog>,
  writtenEvidence?: Array<Parameters<typeof writeCheckinGitHubEvidence>[0]>,
  runtime?: AgentRuntimeSource,
) {
  return createRoutineScanWorker({
    github: { getIssue: async (_repository, number) => ok(issueItem({ number })) },
    serviceEvidence: store,
    writeCheckinEvidence: async (input) => { writtenEvidence?.push(input) },
    githubEvidence: { collect: async () => ({ observedAt: now().toISOString(), issues: { _tag: 'Available', entries: [{ number: 7, title: 'Private controller issue' }], truncated: false }, pullRequests: { _tag: 'Available', entries: [], truncated: false }, workflowRuns: { _tag: 'Unavailable', reason: 'Controller cannot read Actions' }, deployments: { _tag: 'Available', entries: [], truncated: false }, deploymentStatuses: [], jobLogs: { _tag: 'NotRequested' }, ownership: { _tag: 'NotRequested' } }) },
    ...(activityLog === undefined ? {} : { activityLog }),
    logger: { error: () => undefined, info: () => undefined },
    ...(maximumChangedFiles === undefined ? {} : { maximumChangedFiles }),
    now,
    runtime: runtime ?? (() => ({ profile: CODEX_AGENT_PROFILE, provider })),
    store,
    workspaces: { prepareRoutine: async () => ok({ path: '/tmp/routine', baseSha: 'abc123', headSha: 'abc123', defaultBranchSha: 'abc123' }) },
  })
}

function seed(store: ReturnType<typeof openJournalStore>, name: ClaimedRoutineRun['name'] = 'pr-triage'): void {
  store.syncRepositories([repositoryMapping()], '2026-08-27T00:00:00.000Z')
  store.syncRoutines({
    repository: 'harlan-zw/example',
    specSha: 'abc123',
    entries: [{ name, crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'propose', enabled: true }],
    at: '2026-08-27T00:00:00.000Z',
  })
  store.openRoutineRun({
    routineId: `harlan-zw/example:${name}`,
    scheduledFor: '2026-08-27T07:00:00.000Z',
    specSha: 'abc123',
    at: '2026-08-27T07:00:05.000Z',
  })
}

const candidate = {
  urgency: 'urgent',
  fingerprint: 'src/store.ts#openRoutineRun',
  title: 'Fixture title',
  target: 'src/store.ts',
  claim: 'This helper is never called.',
  verification: 'pnpm test',
  estimatedChangedFiles: 1,
}

describe('building the scan prompt', () => {
  it.each(['seo-review', 'vitals-review', 'daily-checkin', 'ci-review'] as const)('requests the appropriate private evidence for %s', async (name) => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, name)
      const capture = { prompts: [] as string[] }
      const scopes: Array<string | undefined> = []
      const answers = {
        'seo-review': { report: 'No findings.', candidates: [] },
        'vitals-review': { report: 'No findings.', fieldFindings: [], labFindings: [] },
        'daily-checkin': { report: 'No findings.', candidates: [], verdict: { severity: 'GREEN', coverage: 'complete' } },
        'ci-review': { report: 'No findings.', candidates: [] },
      }
      const provider = scanning(answers[name], capture)
      const worker = createRoutineScanWorker({
        github: { getIssue: async (_repository, number) => ok(issueItem({ number })) },
        now,
        store,
        logger: { error: () => undefined, info: () => undefined },
        runtime: () => ({ profile: CODEX_AGENT_PROFILE, provider }),
        workspaces: { prepareRoutine: async () => ok({ path: '/tmp/routine', baseSha: 'abc123', headSha: 'abc123', defaultBranchSha: 'abc123' }) },
        writeCheckinEvidence: async () => undefined,
        githubEvidence: { collect: async (_mapping, _signal, _jobs, _branch, evidenceScope) => {
          scopes.push(evidenceScope)
          return collectRoutineGitHubEvidence({ repository: 'harlan-zw/example', now, ...(evidenceScope === undefined ? {} : { evidenceScope }), read: async path => path.includes('/issues?')
            ? ok([{ number: 13, body: 'The shared stylesheet already has an owner.' }])
            : ok([]) })
        } },
      })
      const result = await worker.run(claimStoredRun(store), new AbortController().signal)
      expect(result._tag).toBe('Ok')
      expect(scopes).toEqual([name === 'ci-review' ? 'metadata' : 'ownership'])
      expect(capture.prompts[0]?.includes('The shared stylesheet already has an owner.')).toBe(name !== 'ci-review')
    }
    finally {
      store.close()
    }
  })

  it('executes only the selected scan on Codex while the Service stays on OpenCode', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'ci-review')
      const capture = { prompts: [] as string[], requests: [] as AgentTurnRequest[] }
      const provider = scanning({ report: 'No findings.', candidates: [] }, capture)
      const runtime = createAgentRuntimeSource({
        configuredProvider: 'opencode',
        maximumActiveAgents: 1,
        providers: { codex: provider, opencode: { name: 'opencode', async* runTurn() { yield { _tag: 'Failed', reason: 'OpenCode is exhausted.' } } } },
        selection: () => ({ _tag: 'Pinned', provider: 'opencode', model: 'zai-coding-plan/glm-5.3', reasoningEffort: 'high' }),
      })
      const task = { ...claimStoredRun(store), agentSelection: { provider: 'codex' as const, model: 'gpt-6.1-sol' as const, reasoningEffort: 'medium' as const } }
      const result = await workerFor(store, provider, undefined, undefined, undefined, runtime).run(task, new AbortController().signal)

      expect(result._tag).toBe('Ok')
      expect(capture.requests[0]).toMatchObject({ model: 'gpt-6.1-sol', reasoningEffort: 'medium' })
      expect(runtime().provider.name).toBe('opencode')
    }
    finally {
      store.close()
    }
  })

  it('labels a Candidate the ledger already holds as already known', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'ci-review')
      store.setRepositoryWritesEnabled('harlan-zw/example', true)
      const priorRun = store.openRoutineRun({
        routineId: 'harlan-zw/example:ci-review',
        scheduledFor: '2026-08-26T07:00:00.000Z',
        specSha: 'abc123',
        at: '2026-08-26T07:00:05.000Z',
      })
      if (priorRun === null)
        throw new Error('Expected the prior Routine run.')
      store.recordCandidates({
        routineId: 'harlan-zw/example:ci-review',
        runId: priorRun.id,
        candidates: [candidate],
        at: '2026-08-26T07:05:00.000Z',
      })
      const fresh = { ...candidate, fingerprint: 'scripts/alerts.log#count', title: 'Alert count grew by one' }
      const task = claimStoredRun(store)
      const capture = { prompts: [] as string[] }
      const result = await workerFor(store, scanning({ report: 'One repeat, one new.', candidates: [candidate, fresh] }, capture))
        .run(task, new AbortController().signal)

      expect(result._tag).toBe('Ok')
      if (result._tag !== 'Ok')
        throw new Error(result.error)
      expect(capture.prompts[0]).toContain('Private controller issue')
      expect(capture.prompts[0]).toContain('Controller cannot read Actions')
      expect(result.value.evidence).toContain('1 already known')
      expect(result.value.evidence).toContain('1 new')
      const known = store.listCandidates('harlan-zw/example:ci-review').find(entry => entry.fingerprint === candidate.fingerprint)
      expect(known?.runId).toBe(priorRun.id)
    }
    finally {
      store.close()
    }
  })

  it('keeps Agent feedback proposals inside one skill and its replay', () => {
    expect(getRoutine('agent-feedback').selectCandidates([
      { ...candidate, target: 'src/controller.ts' },
      { ...candidate, estimatedChangedFiles: 3, fingerprint: 'skill-a', target: 'harlan-agent-kit/skills/adversarial-review/SKILL.md' },
      { ...candidate, estimatedChangedFiles: 3, fingerprint: 'skill-b', target: 'harlan-agent-kit/skills/pr-triage/SKILL.md' },
    ])).toEqual([{ ...candidate, estimatedChangedFiles: 3, fingerprint: 'skill-a', target: 'harlan-agent-kit/skills/adversarial-review/SKILL.md' }])
  })

  it('passes explicit signals to the Agent feedback skill as evidence', () => {
    const prompt = routineScanPrompt({
      mode: 'propose',
      name: 'agent-feedback',
      priorCandidates: [],
      repository: 'harlan-zw/harlan-agent-kit',
      feedback: [{
        reviewRunId: 'review-1',
        repository: 'harlan-zw/example',
        pullRequestNumber: 24,
        headSha: 'abc123',
        completedAt: '2026-08-29T00:00:00.000Z',
        durationMs: 2_000,
        reviewRunsForHead: 1,
        usage: { _tag: 'Unavailable' },
        outcome: { _tag: 'Ready' },
        findings: [],
        feedback: { _tag: 'Wrong', reason: 'The finding did not reproduce.', updatedAt: '2026-08-29T00:01:00.000Z' },
      }],
    })

    expect(prompt).toContain('harlan-agent-kit/skills/agent-feedback/SKILL.md')
    expect(prompt).toContain('The finding did not reproduce.')
    expect(prompt).toContain('controller defect')
  })

  it('lets a proposing Sentry Routine close verified fixes and persist its ledger', () => {
    const prompt = routineScanPrompt({ mode: 'propose', name: 'sentry-checkin', priorCandidates: [], repository: 'harlan-zw/example' })

    expect(prompt).toContain('harlan-agent-kit:sentry-checkin')
    expect(prompt).toContain('references/scheduled-routine.md')
    expect(prompt).toContain('Resolve eligible issues in their verified deployed release during this run.')
    expect(prompt).toContain('Persist the audited ledger and record the run history, even with zero code proposals.')
    expect(prompt).not.toContain('This turn is read only')
  })

  it('keeps Sentry report mode read only while allowing local evidence files', () => {
    const prompt = routineScanPrompt({ mode: 'report', name: 'sentry-checkin', priorCandidates: [], repository: 'harlan-zw/example' })

    expect(prompt).toContain('Keep Sentry read only. Do not resolve issues or run resolve with --apply.')
    expect(prompt).toContain('Persist the audited ledger and record the run history, even with zero code proposals.')
    expect(prompt).not.toContain('Resolve eligible issues in their verified deployed release during this run.')
  })

  it('routes a check-in through the shared skill and durable report directory', () => {
    const prompt = routineScanPrompt({ mode: 'propose', name: 'daily-checkin', priorCandidates: [], repository: 'skilld-dev/skilld.dev' })

    expect(prompt).toContain('harlan-agent-kit:daily-checkin')
    expect(prompt).toContain('Preserve DAILY_CHECKIN_DIR and keep evidence, reports, and the ledger there.')
    expect(prompt).not.toContain('This turn is read only')
  })

  it('says the turn is read only', () => {
    const prompt = routineScanPrompt({ mode: 'propose', name: 'pr-triage', priorCandidates: [], repository: 'harlan-zw/example' })

    expect(prompt).toContain('read only')
  })

  it('carries every prior rejection and its reason', () => {
    const prompt = routineScanPrompt({
      mode: 'propose',
      name: 'pr-triage',
      priorCandidates: [{
        id: 'c1',
        routineId: 'r1',
        runId: 'run-1',
        fingerprint: 'src/old.ts',
        title: 'Fixture title',
        target: 'src/old.ts',
        claim: 'unused',
        verification: 'pnpm test',
        estimatedChangedFiles: 1,
        result: { _tag: 'Rejected', reason: 'This file is generated.' },
        createdAt: '',
        updatedAt: '',
      }],
      repository: 'harlan-zw/example',
    })

    expect(prompt).toContain('src/old.ts: This file is generated.')
  })

  it('carries an open proposal into the next scan', () => {
    const prompt = routineScanPrompt({
      mode: 'propose',
      name: 'pr-triage',
      priorCandidates: [{
        id: 'c1',
        routineId: 'r1',
        runId: 'run-1',
        fingerprint: 'src/open.ts',
        title: 'Fixture title',
        target: 'src/open.ts',
        claim: 'unused',
        verification: 'pnpm test',
        estimatedChangedFiles: 1,
        result: { _tag: 'Proposed', pullRequest: null },
        createdAt: '',
        updatedAt: '',
      }],
      repository: 'harlan-zw/example',
    })

    expect(prompt).toContain('src/open.ts')
    expect(prompt).toContain('unused')
    expect(prompt).toContain(JSON.stringify({ _tag: 'Proposed', pullRequest: null }))
  })

  it.each([
    { _tag: 'Merged', pullRequest: 42 } as const,
    { _tag: 'Superseded', reason: 'Handled by another fix.' } as const,
  ])('preserves a $_tag Candidate for deployment and regression checks', (result) => {
    const prompt = routineScanPrompt({
      mode: 'propose',
      name: 'pr-triage',
      priorCandidates: [{
        id: 'c1',
        routineId: 'r1',
        runId: 'run-1',
        fingerprint: 'src/closed.ts',
        title: 'Fixture title',
        target: 'src/closed.ts',
        claim: 'unused',
        verification: 'pnpm test',
        estimatedChangedFiles: 1,
        result,
        createdAt: '',
        updatedAt: '',
      }],
      repository: 'harlan-zw/example',
    })

    expect(prompt).toContain('src/closed.ts')
    expect(prompt).toContain(JSON.stringify(result))
    expect(prompt).toContain('Nothing has been rejected yet.')
  })

  it('tells a report routine that nothing it proposes gets built', () => {
    const prompt = routineScanPrompt({ mode: 'report', name: 'pr-triage', priorCandidates: [], repository: 'harlan-zw/example' })

    expect(prompt).toContain('reports only')
  })
})

describe('running one scan', () => {
  it.each([
    { outcome: 'existing_work', report: 'PR https://github.com/harlan-zw/example/pull/25 needs a rebase. Harlan owns it.', state: 'Completed', attempts: 1 },
    { outcome: 'blocked', report: 'Registry authentication failed.', state: 'Failed', attempts: 3 },
  ])('settles dependency $outcome after $attempts attempts and publishes its reason', async ({ outcome, report, state, attempts }) => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'dependency-updates')
      store.setRepositoryWritesEnabled('harlan-zw/example', true)
      const capture = { prompts: [] as string[], requests: [] as AgentTurnRequest[] }
      const scheduler = createWorkerTaskScheduler({
        claim: store.claimNextRoutineRun,
        complete: store.completeRoutineRun,
        fail: store.failRoutineRun,
        heartbeat: store.heartbeatRoutineRun,
        intervalMilliseconds: 60_000,
        leaseMilliseconds: 60_000,
        now,
        onError: (error) => { throw error },
        permits: createAgentPermitPool(1),
        worker: workerFor(store, scanning({ outcome, report, updates: [] }, capture)),
        workerId: 'worker-1',
      })

      for (let attempt = 0; attempt < 4; attempt++)
        await scheduler.runNow()

      expect(store.listRoutineRuns('harlan-zw/example:dependency-updates')[0])
        .toMatchObject({ state: { _tag: state }, attempts })
      expect(capture.requests).toHaveLength(attempts)
      expect(store.listCandidates('harlan-zw/example:dependency-updates')).toEqual([])
      expect(store.claimNextCandidateIssue('controller-1', now().toISOString(), 60_000)).toBeNull()
      const published = store.claimNextRoutineReport('controller-1', now().toISOString(), 60_000)
      expect(published?.body).toContain(report)
      if (outcome === 'existing_work') {
        expect(published?.body).toContain('Dependency scan skipped because dependency work is open.')
        expect(published?.body).toContain('Registry coverage is not established by this result.')
      }
      else {
        expect(published?.body).toContain('Failed. Dependency scan blocked: Registry authentication failed.')
      }
      expect(store.claimNextRoutineReport('controller-2', now().toISOString(), 60_000)).toBeNull()
      await scheduler.stop()
    }
    finally {
      store.close()
    }
  })

  it.each(['pr-triage', 'sentry-checkin', 'ci-review', 'perf-review', 'seo-review'] as const)(
    'completes %s without a check-in verdict',
    async (name) => {
      const store = openJournalStore(':memory:')
      try {
        seed(store, name)
        const result = await workerFor(store, scanning({ report: 'No findings.', verdict: null, candidates: [] }))
          .run(claimStoredRun(store), new AbortController().signal)

        expect(result).toMatchObject({ _tag: 'Ok' })
        expect(store.listCandidates(`harlan-zw/example:${name}`)).toEqual([])
      }
      finally {
        store.close()
      }
    },
  )

  it('rejects oversized CI reports before persisting findings', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'ci-review')
      store.setRepositoryWritesEnabled('harlan-zw/example', true)
      const report = `${'x'.repeat(20_000)}Final warning requires repair.`
      const result = await workerFor(store, scanning({ report, candidates: [candidate] }))
        .run(claimStoredRun(store), new AbortController().signal)

      expect(result).toEqual({ _tag: 'Err', error: 'The CI review report exceeds 20000 characters. Shorten it and mark coverage incomplete if diagnostic dispositions cannot fit.' })
      expect(store.listCandidates('harlan-zw/example:ci-review')).toEqual([])
      expect(store.claimNextCandidateIssue('controller-1', now().toISOString(), 60_000)).toBeNull()
      expect(store.claimNextRoutineReport('controller-1', now().toISOString(), 60_000)).toBeNull()
    }
    finally {
      store.close()
    }
  })

  it('preserves the last diagnostic in a CI report at the detail limit', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'ci-review')
      store.setRepositoryWritesEnabled('harlan-zw/example', true)
      const diagnostic = 'Final warning: deprecated API. Existing issue #42 owns its repair.'
      const report = `${'x'.repeat(20_000 - diagnostic.length)}${diagnostic}`
      const task = claimStoredRun(store)
      const result = await workerFor(store, scanning({ report, candidates: [] }))
        .run(task, new AbortController().signal)

      expect(result._tag).toBe('Ok')
      store.completeRoutineRun({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at: now().toISOString(),
        evidence: result._tag === 'Ok' ? result.value.evidence : '',
      })
      expect(store.claimNextRoutineReport('controller-1', now().toISOString(), 60_000)?.body).toContain(report)
    }
    finally {
      store.close()
    }
  })

  it('records CI evidence and queues a repair for triage', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'ci-review')
      store.setRepositoryWritesEnabled('harlan-zw/example', true)
      const report = 'Run 42 succeeded but emitted a deprecated API warning in the build step.'
      const task = claimStoredRun(store)
      const result = await workerFor(store, scanning({ report, candidates: [candidate] }))
        .run(task, new AbortController().signal)
      expect(result._tag).toBe('Ok')
      store.completeRoutineRun({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at: now().toISOString(),
        evidence: result._tag === 'Ok' ? result.value.evidence : '',
      })
      expect(store.claimNextCandidateIssue('controller-1', now().toISOString(), 60_000))
        .toMatchObject({ routineName: 'ci-review', fingerprint: candidate.fingerprint })
      expect(store.claimNextRoutineReport('controller-1', now().toISOString(), 60_000)?.body).toContain(report)
    }
    finally {
      store.close()
    }
  })

  it('publishes one dependency proposal across more than five manifests', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'dependency-updates')
      store.setRepositoryWritesEnabled('harlan-zw/example', true)
      const updates = Array.from({ length: 8 }, (_, index) => ({
        manifest: `packages/app${index}/package.json`,
        name: 'nuxt',
        current: '4.0.0',
        latest: '5.0.0',
      }))
      const task = claimStoredRun(store)
      const result = await workerFor(store, scanning({ outcome: 'complete', report: 'Eight manifests scanned.', updates }))
        .run(task, new AbortController().signal)
      expect(result._tag).toBe('Ok')
      store.completeRoutineRun({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at: now().toISOString(),
        evidence: result._tag === 'Ok' ? result.value.evidence : '',
      })
      const issue = store.claimNextCandidateIssue('controller-1', now().toISOString(), 60_000)
      expect(issue).toMatchObject({ routineName: 'dependency-updates', body: expect.stringContaining('packages/app7/package.json') })
      expect(store.claimNextCandidateIssue('controller-2', now().toISOString(), 60_000)).toBeNull()
      expect(store.claimNextRoutineReport('controller-1', now().toISOString(), 60_000)?.body).toContain('Eight manifests scanned.')
    }
    finally {
      store.close()
    }
  })

  it('reports zero code proposals without hiding the Sentry issue ledger', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'sentry-checkin')
      store.setRepositoryWritesEnabled('harlan-zw/example', true)
      const detail = '12 Sentry issues. 12 ledger rows. 12 resolved in release abc123. History recorded.'

      const task = claimStoredRun(store)
      const result = await workerFor(store, scanning({ report: detail, candidates: [] }))
        .run(task, new AbortController().signal)

      expect(result).toMatchObject({ _tag: 'Ok', value: { evidence: expect.stringContaining('0 code proposals') } })
      store.completeRoutineRun({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at: now().toISOString(),
        evidence: result._tag === 'Ok' ? result.value.evidence : '',
      })
      const report = store.claimNextRoutineReport('controller-1', now().toISOString(), 60_000)
      expect(report?.body).toContain('0 code proposals')
      expect(report?.body).toContain(detail)
      expect(store.claimNextCandidateIssue('controller-1', now().toISOString(), 60_000)).toBeNull()
    }
    finally {
      store.close()
    }
  })

  it.each([undefined, '', '  '])('refuses a Sentry result without a report: %s', async (report) => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'sentry-checkin')
      store.setRepositoryWritesEnabled('harlan-zw/example', true)

      const result = await workerFor(store, scanning({ report, candidates: [candidate] }))
        .run(claimStoredRun(store), new AbortController().signal)

      expect(result).toEqual({ _tag: 'Err', error: 'The Sentry Routine answered without its issue report.' })
      expect(store.claimNextRoutineReport('controller-1', now().toISOString(), 60_000)).toBeNull()
      expect(store.claimNextCandidateIssue('controller-1', now().toISOString(), 60_000)).toBeNull()
    }
    finally {
      store.close()
    }
  })

  it('refuses a daily check-in that states no verdict', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'daily-checkin')
      store.setRepositoryWritesEnabled('harlan-zw/example', true)
      const result = await workerFor(store, scanning({ report: 'GREEN. Everything passed.', candidates: [candidate] }))
        .run(claimStoredRun(store), new AbortController().signal)
      expect(result).toEqual({ _tag: 'Err', error: 'The daily check-in Routine answered without its verdict.' })
      expect(store.claimNextRoutineReport('controller-1', now().toISOString(), 60_000)).toBeNull()
    }
    finally {
      store.close()
    }
  })

  it('hands scoped private evidence to the collector before starting a daily turn', async () => {
    const store = openJournalStore(':memory:')
    const written: Array<Parameters<typeof writeCheckinGitHubEvidence>[0]> = []
    try {
      seed(store, 'daily-checkin')
      store.setRepositoryWritesEnabled('harlan-zw/example', true)
      await workerFor(store, scanning({ report: 'Controller read is unavailable.', candidates: [], verdict: { severity: 'AMBER', coverage: 'incomplete' } }), undefined, undefined, written)
        .run(claimStoredRun(store), new AbortController().signal)
      expect(written).toMatchObject([{ workspace: '/tmp/routine', repository: 'harlan-zw/example', branch: 'main', evidence: { observedAt: now().toISOString(), workflowRuns: { _tag: 'Unavailable', reason: 'Controller cannot read Actions' } } }])
    }
    finally {
      store.close()
    }
  })

  it.each([undefined, '', '  '])('refuses a daily check-in without its report: %s', async (report) => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'daily-checkin')
      store.setRepositoryWritesEnabled('harlan-zw/example', true)
      const result = await workerFor(store, scanning({ report, candidates: [candidate], verdict: { severity: 'GREEN', coverage: 'complete' } }))
        .run(claimStoredRun(store), new AbortController().signal)
      expect(result).toEqual({ _tag: 'Err', error: 'The daily check-in Routine answered without its report.' })
      expect(store.claimNextRoutineReport('controller-1', now().toISOString(), 60_000)).toBeNull()
      expect(store.claimNextCandidateIssue('controller-1', now().toISOString(), 60_000)).toBeNull()
    }
    finally {
      store.close()
    }
  })

  it('refuses the global Agent feedback Routine in another repository', async () => {
    const store = openJournalStore(':memory:')
    try {
      store.syncRepositories([repositoryMapping()], '2026-08-27T00:00:00.000Z')
      store.syncRoutines({
        repository: 'harlan-zw/example',
        specSha: 'abc123',
        entries: [{ name: 'agent-feedback', crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'propose', enabled: true }],
        at: '2026-08-27T00:00:00.000Z',
      })
      store.openRoutineRun({
        routineId: 'harlan-zw/example:agent-feedback',
        scheduledFor: '2026-08-27T07:00:00.000Z',
        specSha: 'abc123',
        at: '2026-08-27T07:00:05.000Z',
      })

      const result = await workerFor(store, scanning({ candidates: [] }))
        .run(claimStoredRun(store), new AbortController().signal)

      expect(result).toEqual({ _tag: 'Err', error: 'The Agent feedback Routine only runs in harlan-zw/harlan-agent-kit.' })
    }
    finally {
      store.close()
    }
  })

  it('reports live progress and provider activity', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const task = claimStoredRun(store)
      const activityLog = createAgentActivityLog()
      const provider = {
        name: 'codex' as const,
        runTurn: () => (async function* (): AsyncIterable<AgentEvent> {
          yield { _tag: 'SessionStarted', sessionId: 'session-1' }
          yield { _tag: 'Reasoning', text: 'Checking the repository.' }
          yield { _tag: 'CommandCompleted', command: 'pnpm test', output: 'passed', exitCode: 0 }
          yield { _tag: 'Message', text: JSON.stringify({ candidates: [] }) }
          yield { _tag: 'TurnCompleted' }
        })(),
      }

      const result = await workerFor(store, provider, undefined, activityLog)
        .run(task, new AbortController().signal)

      expect(result).toMatchObject({ _tag: 'Ok' })
      expect(activityLog.read(task.id)).toEqual([
        { _tag: 'Reasoning', at: now().toISOString(), text: 'Checking the repository.' },
        { _tag: 'Command', at: now().toISOString(), command: 'pnpm test', output: 'passed', exitCode: 0 },
      ])
      expect(store.listRoutineRuns(task.routineId)[0]).toMatchObject({
        progress: { percent: 85, label: 'Preparing the Routine result' },
      })
    }
    finally {
      store.close()
    }
  })

  it('records what the scan found', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const result = await workerFor(store, scanning({ candidates: [candidate] }))
        .run(claimStoredRun(store), new AbortController().signal)

      expect(result).toMatchObject({ _tag: 'Ok' })
      expect(store.listCandidates('harlan-zw/example:pr-triage')).toMatchObject([{ fingerprint: candidate.fingerprint }])
      expect(store.getDashboardSnapshot(now().toISOString()).routineRuns[0]).toMatchObject({
        candidates: [{ fingerprint: candidate.fingerprint }],
      })
    }
    finally {
      store.close()
    }
  })

  it('carries a check-in report into the run log', async () => {
    const store = openJournalStore(':memory:')
    try {
      store.syncRepositories([repositoryMapping()], '2026-08-27T00:00:00.000Z')
      store.setRepositoryWritesEnabled('harlan-zw/example', true)
      store.syncRoutines({
        repository: 'harlan-zw/example',
        specSha: 'abc123',
        entries: [{ name: 'daily-checkin', crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'propose', enabled: true }],
        at: '2026-08-27T00:00:00.000Z',
      })
      store.openRoutineRun({ routineId: 'harlan-zw/example:daily-checkin', scheduledFor: '2026-08-27T07:00:00.000Z', specSha: 'abc123', at: '2026-08-27T07:00:05.000Z' })
      const task = claimStoredRun(store)
      const worker = workerFor(store, scanning({
        report: 'AMBER. One probe failed.\n\n## Broken\n\n- d1 unreachable',
        candidates: [candidate],
        verdict: { severity: 'AMBER', coverage: 'complete' },
      }))

      const result = await worker.run(task, new AbortController().signal)

      expect(result._tag).toBe('Ok')
      if (result._tag === 'Ok') {
        store.completeRoutineRun({
          taskId: task.id,
          workerId: task.state.workerId,
          fence: task.state.fence,
          at: now().toISOString(),
          evidence: result.value.evidence,
        })
      }
      const report = store.claimNextRoutineReport('controller-1', now().toISOString(), 60_000)
      expect(report?.body).toContain('1 found | 1 new')
      expect(report?.body).toContain('AMBER. One probe failed.')
      expect(report?.body).toContain('- d1 unreachable')
    }
    finally {
      store.close()
    }
  })

  it('keeps the run alive when a Candidate arrives without a usable title', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const untitled = {
        fingerprint: candidate.fingerprint,
        target: candidate.target,
        claim: candidate.claim,
        verification: candidate.verification,
        estimatedChangedFiles: candidate.estimatedChangedFiles,
      }
      const numbered = { ...candidate, fingerprint: 'src/answer.ts#main', title: 42 }

      const result = await workerFor(store, scanning({ candidates: [untitled, numbered] }))
        .run(claimStoredRun(store), new AbortController().signal)

      expect(result).toMatchObject({ _tag: 'Ok' })
      expect(store.listCandidates('harlan-zw/example:pr-triage')).toMatchObject([
        { fingerprint: untitled.fingerprint, title: untitled.claim },
        { fingerprint: numbered.fingerprint, title: numbered.claim },
      ])
    }
    finally {
      store.close()
    }
  })

  it('drops a proposal larger than the file limit before it reaches the ledger', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      await workerFor(store, scanning({
        candidates: [candidate, { ...candidate, fingerprint: 'src/big.ts', estimatedChangedFiles: 40 }],
      })).run(claimStoredRun(store), new AbortController().signal)

      expect(store.listCandidates('harlan-zw/example:pr-triage').map(entry => entry.fingerprint))
        .toEqual([candidate.fingerprint])
    }
    finally {
      store.close()
    }
  })

  it('records a Candidate once across two runs', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const worker = workerFor(store, scanning({ candidates: [candidate] }))
      const firstTask = claimStoredRun(store)
      await worker.run(firstTask, new AbortController().signal)
      store.completeRoutineRun({
        taskId: firstTask.id,
        workerId: firstTask.state.workerId,
        fence: firstTask.state.fence,
        at: '2026-08-27T07:06:00.000Z',
        evidence: 'First scan completed.',
      })

      store.openRoutineRun({
        routineId: 'harlan-zw/example:pr-triage',
        scheduledFor: '2026-08-28T07:00:00.000Z',
        specSha: 'abc123',
        at: '2026-08-28T07:00:05.000Z',
      })
      const secondTask = claimStoredRun(store, '2026-08-28T07:05:00.000Z')
      const second = await worker.run(
        secondTask,
        new AbortController().signal,
      )

      expect(second).toMatchObject({ _tag: 'Ok' })
      expect(store.listCandidates('harlan-zw/example:pr-triage')).toHaveLength(1)
    }
    finally {
      store.close()
    }
  })

  it('restages a Candidate command after a crash between its ledger writes', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const task = claimStoredRun(store)
      store.recordCandidates({
        routineId: task.routineId,
        runId: task.id,
        candidates: [candidate],
        at: '2026-08-27T07:05:00.000Z',
      })

      await workerFor(store, scanning({ candidates: [candidate] }))
        .run(task, new AbortController().signal)

      store.setRepositoryWritesEnabled(task.repository, true)
      expect(store.claimNextCandidateIssue('controller-1', '2026-08-27T07:06:00.000Z', 60_000))
        .toMatchObject({ candidateId: `${task.id}:${candidate.fingerprint}` })
    }
    finally {
      store.close()
    }
  })

  it('sends a prior rejection back to the next scan', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const capture = { prompts: [] as string[] }
      await workerFor(store, scanning({ candidates: [candidate] }, capture))
        .run(claimStoredRun(store), new AbortController().signal)

      expect(capture.prompts[0]).toContain('Nothing has been rejected yet.')
    }
    finally {
      store.close()
    }
  })

  it('keeps the scan prompt bounded while the Candidate history grows', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const claim = 'This helper duplicates the lease check and confuses the retry path.'.padEnd(4096, ' pad')
      for (let day = 0; day < 10; day += 1) {
        const hour = String(8 + day).padStart(2, '0')
        const task = claimStoredRun(store, `2026-08-27T${hour}:05:00.000Z`)
        store.recordCandidates({
          routineId: task.routineId,
          runId: task.id,
          candidates: Array.from({ length: 10 }, (_, index) => ({
            fingerprint: `src/day${day}/feature${index}.ts`,
            title: `Day ${day} finding ${index}`,
            target: `src/day${day}/feature${index}.ts`,
            claim,
            verification: 'pnpm test',
            estimatedChangedFiles: 1,
          })),
          at: `2026-08-27T${hour}:10:00.000Z`,
        })
        store.completeRoutineRun({
          taskId: task.id,
          workerId: task.state.workerId,
          fence: task.state.fence,
          at: `2026-08-27T${hour}:20:00.000Z`,
          evidence: `Day ${day} scan recorded.`,
        })
        store.openRoutineRun({
          routineId: 'harlan-zw/example:pr-triage',
          scheduledFor: `2026-08-27T${hour}:30:00.000Z`,
          specSha: 'abc123',
          at: `2026-08-27T${hour}:30:05.000Z`,
        })
      }

      const capture = { prompts: [] as string[] }
      const result = await workerFor(store, scanning({ candidates: [] }, capture))
        .run(claimStoredRun(store, '2026-08-27T18:35:00.000Z'), new AbortController().signal)

      expect(result).toMatchObject({ _tag: 'Ok' })
      expect(store.listCandidates('harlan-zw/example:pr-triage')).toHaveLength(100)
      // Ten runs of ten multi-Kilobyte Candidates build a history far larger
      // than one turn may read. The prompt stays a fixed size whatever the
      // ledger holds, and the window keeps the newest Candidates.
      const prompt = capture.prompts[0] ?? ''
      expect(prompt.length).toBeLessThan(200_000)
      expect(prompt).toContain('src/day9/feature9.ts')
    }
    finally {
      store.close()
    }
  })

  it('fails when the scan answers something other than JSON', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const provider = {
        name: 'codex' as const,
        runTurn: () => (async function* (): AsyncIterable<AgentEvent> {
          yield { _tag: 'Message', text: 'I had a look and everything seems fine.' }
          yield { _tag: 'TurnCompleted' }
        })(),
      }
      const result = await workerFor(store, provider).run(claimStoredRun(store), new AbortController().signal)

      expect(result._tag).toBe('Err')
    }
    finally {
      store.close()
    }
  })

  it('opens a blocked dated issue for a daily run that failed every attempt', async () => {
    const store = openJournalStore(':memory:')
    try {
      store.syncRepositories([repositoryMapping()], '2026-08-27T00:00:00.000Z')
      store.setRepositoryWritesEnabled('harlan-zw/example', true)
      store.syncRoutines({
        repository: 'harlan-zw/example',
        specSha: 'abc123',
        entries: [{ name: 'daily-checkin', crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'propose', enabled: true }],
        at: '2026-08-27T00:00:00.000Z',
      })
      store.openRoutineRun({
        routineId: 'harlan-zw/example:daily-checkin',
        scheduledFor: '2026-08-27T07:00:00.000Z',
        specSha: 'abc123',
        at: '2026-08-27T07:00:05.000Z',
      })
      const task = claimStoredRun(store)
      const provider = {
        name: 'codex' as const,
        runTurn: () => (async function* (): AsyncIterable<AgentEvent> {
          yield { _tag: 'Message', text: 'I had a look and everything seems fine.' }
          yield { _tag: 'TurnCompleted' }
        })(),
      }
      const result = await workerFor(store, provider).run(task, new AbortController().signal)
      expect(result._tag).toBe('Err')

      const outcomes: string[] = []
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const claimed = attempt === 0 ? task : claimStoredRun(store, `2026-08-27T0${7 + attempt}:05:00.000Z`)
        if (claimed === null)
          break
        outcomes.push(store.failRoutineRun({
          taskId: claimed.id,
          workerId: claimed.state.workerId,
          fence: claimed.state.fence,
          at: `2026-08-27T0${7 + attempt}:06:00.000Z`,
          reason: 'The scan agent answered with something other than JSON.',
        }))
      }
      expect(outcomes).toEqual(['Retrying', 'Retrying', 'Failed'])

      const calls: { issues: string[], comments: string[] } = { issues: [], comments: [] }
      const github: GitHubIssuePublisher = {
        createIssue: async (input) => {
          calls.issues.push(input.title)
          return ok({ number: 42, url: 'https://github.com/harlan-zw/example/issues/42' })
        },
        createComment: async (input) => {
          calls.comments.push(input.body)
          return ok({ id: 900 })
        },
        updateIssue: async (input) => {
          calls.comments.push(input.body)
          return ok(undefined)
        },
        findOpenIssueByFingerprint: async () => ok(null),
        findRoutineTrackingIssue: async () => ok(null),
        findIssueCommentByMarker: async () => ok(null),
      }
      await createRoutineReportController({ github, now, store, workerId: 'reporter' })
        .publishPending(new AbortController().signal)

      expect(calls.issues).toEqual(['[BLOCKED] Daily check-in: harlan-zw/example'])
      expect(calls.comments[0]).toContain('Failed. The scan agent answered with something other than JSON.')
    }
    finally {
      store.close()
    }
  })
})

describe('claiming a Routine run', () => {
  it('keeps restart unsafe while a Routine run holds its lease', () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      expect(claimStoredRun(store)).not.toBeNull()
      store.pauseAgents(now().toISOString())

      expect(store.getDashboardSnapshot(now().toISOString()).agentControl).toMatchObject({ safeToRestart: false })
    }
    finally {
      store.close()
    }
  })

  it('leases one queued run and never the same one twice', () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)

      const first = store.claimNextRoutineRun('worker-1', '2026-08-27T07:05:00.000Z', 60_000)
      const second = store.claimNextRoutineRun('worker-2', '2026-08-27T07:05:01.000Z', 60_000)

      expect(first).toMatchObject({ name: 'pr-triage', state: { _tag: 'Running', workerId: 'worker-1' } })
      expect(second).toBeNull()
    }
    finally {
      store.close()
    }
  })

  it('returns an expired lease to the queue with a new fence', () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const first = store.claimNextRoutineRun('worker-1', '2026-08-27T07:05:00.000Z', 60_000)

      const second = store.claimNextRoutineRun('worker-2', '2026-08-27T09:00:00.000Z', 60_000)

      expect(second?.state.workerId).toBe('worker-2')
      expect(second?.state.fence).toBeGreaterThan(first?.state.fence ?? 0)
    }
    finally {
      store.close()
    }
  })

  it('refuses a heartbeat from a worker that lost the lease', () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const claimed = store.claimNextRoutineRun('worker-1', '2026-08-27T07:05:00.000Z', 60_000)

      const renewed = store.heartbeatRoutineRun({
        taskId: claimed?.id ?? '',
        workerId: 'worker-2',
        fence: claimed?.state.fence ?? 0,
        at: '2026-08-27T07:05:30.000Z',
        leaseMilliseconds: 60_000,
      })

      expect(renewed).toBe(false)
    }
    finally {
      store.close()
    }
  })

  it.each([
    'Variant unavailable for zai-coding-plan/glm-5.3-flash: medium',
    'The opencode session failed: Variant unavailable for zai-coding-plan/glm-5.3-flash: medium',
  ])('fails a rejected provider configuration after one Routine attempt: %s', (reason) => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      store.setRepositoryWritesEnabled('harlan-zw/example', true)
      const claimed = claimStoredRun(store)
      const outcome = store.failRoutineRun({
        taskId: claimed.id,
        workerId: claimed.state.workerId,
        fence: claimed.state.fence,
        at: '2026-08-27T07:06:00.000Z',
        reason,
      })

      expect(outcome).toBe('Failed')
      expect(store.getDashboardSnapshot('2026-08-27T07:06:00.000Z').routineRuns.find(run => run.id === claimed.id))
        .toMatchObject({ state: { _tag: 'Failed', reason }, attempts: 1 })
      expect(store.claimNextRoutineRun('worker-2', '2026-08-27T07:06:00.000Z', 60_000)).toBeNull()
      expect(store.claimNextRoutineRun('worker-2', '2026-08-28T07:06:00.000Z', 60_000)).toBeNull()
      expect(store.claimNextRoutineReport('reporter', '2026-08-28T07:06:00.000Z', 60_000)?.body).toContain(reason)
      expect(store.claimNextRoutineReport('reporter-2', '2026-08-28T07:06:01.000Z', 60_000)).toBeNull()
    }
    finally {
      store.close()
    }
  })

  it.each([
    'The scan agent failed.',
    'Registry authentication failed.',
    'The opencode session failed: Unexpected server error. Check server logs for details.',
  ])('retries other Routine failures until their attempts run out: %s', (reason) => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const outcomes: string[] = []
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const claimed = store.claimNextRoutineRun('worker-1', `2026-08-27T0${7 + attempt}:05:00.000Z`, 60_000)
        if (claimed === null)
          break
        outcomes.push(store.failRoutineRun({
          taskId: claimed.id,
          workerId: 'worker-1',
          fence: claimed.state.fence,
          at: `2026-08-27T0${7 + attempt}:06:00.000Z`,
          reason,
        }))
      }

      expect(outcomes).toEqual(['Retrying', 'Retrying', 'Failed'])
    }
    finally {
      store.close()
    }
  })

  it('claims nothing for a disabled Routine', () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      store.syncRoutines({
        repository: 'harlan-zw/example',
        specSha: 'abc123',
        entries: [{ name: 'pr-triage', crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'propose', enabled: false }],
        at: '2026-08-27T07:01:00.000Z',
      })

      expect(store.claimNextRoutineRun('worker-1', '2026-08-27T07:05:00.000Z', 60_000)).toBeNull()
    }
    finally {
      store.close()
    }
  })
})

describe('agent retro scan publication', () => {
  it('passes durable Service evidence to the Agent and stages the proven fix', async () => {
    const store = openJournalStore(':memory:')
    const repository = 'harlan-zw/harlan-agent-kit'
    try {
      store.syncRepositories([repositoryMapping({ github: repository })], now().toISOString())
      store.setRepositoryWritesEnabled(repository, true)
      store.syncRoutines({ repository, specSha: 'abc123', entries: [{ name: 'agent-retro', crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'propose', enabled: true }], at: now().toISOString() })
      store.openRoutineRun({ routineId: `${repository}:agent-retro`, scheduledFor: now().toISOString(), specSha: 'abc123', at: now().toISOString() })
      const incident = store.recordIncident({ scope: { _tag: 'Service' }, kind: 'unknown', severity: 'error', message: 'A fixture retry loop.', operation: 'fixture', recovery: { _tag: 'ActionRequired' }, at: now().toISOString() })
      const capture = { prompts: [] as string[] }
      const result = await workerFor(store, scanning({ report: `Incident ${incident.id} needs a repair.`, verdict: { severity: 'RED', coverage: 'incomplete' }, candidates: [{ ...candidate, target: 'packages/harlan-github-agent/src/store.ts' }] }, capture))
        .run(claimStoredRun(store), new AbortController().signal)
      expect(result._tag).toBe('Ok')
      expect(capture.prompts[0]).toContain(incident.id)
      expect(capture.prompts[0]).toContain('A fixture retry loop.')
      expect(store.listCandidates(`${repository}:agent-retro`)).toMatchObject([{ target: 'packages/harlan-github-agent/src/store.ts' }])
      const command = store.claimNextCandidateIssue('publisher', now().toISOString(), 60_000)
      expect(command).toMatchObject({ repository, body: expect.stringContaining('packages/harlan-github-agent/src/store.ts') })
    }
    finally {
      store.close()
    }
  })
})

describe('trial report scan', () => {
  const repository = 'harlan-zw/harlan-agent-kit'

  it('hands the Agent every trial reading, files no issue, and logs the report', async () => {
    const store = openJournalStore(':memory:')
    try {
      store.syncRepositories([repositoryMapping({ github: repository })], now().toISOString())
      store.setRepositoryWritesEnabled(repository, true)
      store.syncRoutines({ repository, specSha: 'abc123', entries: [{ name: 'trial-report', crons: ['0 6 * * 1'], timeZone: 'Australia/Melbourne', mode: 'report', enabled: true }], at: now().toISOString() })
      store.openRoutineRun({ routineId: `${repository}:trial-report`, scheduledFor: now().toISOString(), specSha: 'abc123', at: now().toISOString() })
      const capture = { prompts: [] as string[] }
      const report = '### 2. Stop repeating an unchanged Action required Task\n\nParked.'
      const task = claimStoredRun(store)
      const result = await workerFor(store, scanning({ report, verdict: null, candidates: [candidate] }, capture))
        .run(task, new AbortController().signal)

      expect(result).toMatchObject({ _tag: 'Ok', value: { evidence: expect.stringContaining('0 issues requested') } })
      store.completeRoutineRun({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: now().toISOString(), evidence: result._tag === 'Ok' ? result.value.evidence : '' })
      expect(capture.prompts[0]).toContain('"id":"daily-checkin-when-changed"')
      expect(capture.prompts[0]).toContain('"id":"path-rule-shadow"')
      expect(capture.prompts[0]).not.toContain('Private controller issue')
      expect(store.listCandidates(`${repository}:trial-report`)).toEqual([])
      expect(store.claimNextCandidateIssue('publisher', now().toISOString(), 60_000)).toBeNull()
      expect(store.claimNextRoutineReport('controller-1', now().toISOString(), 60_000)?.body).toContain(report)
    }
    finally {
      store.close()
    }
  })

  it('refuses a scan outside the kit before reading any evidence', () => {
    expect(getRoutine('trial-report').prepare('harlan-zw/example', { listAgentFeedback: () => [], listImplicitSignals: () => [] })._tag).toBe('Err')
  })

  it('refuses an answer without a report', () => {
    expect(getRoutine('trial-report').parseResponse({ report: '', verdict: null, candidates: [] })._tag).toBe('Err')
  })
})

describe('running a daily check-in only when the site changed', () => {
  const routineId = 'harlan-zw/example:daily-checkin'
  const yesterday = '2026-08-26T07:00:00.000Z'
  const today = '2026-08-27T07:00:00.000Z'
  const deployProd = { _tag: 'Enabled' as const, productionUrl: 'https://example.com', requiredWorkflows: ['deploy-prod.yml'], smokePaths: ['/'] }

  function sync(store: ReturnType<typeof openJournalStore>, specSha: string, when: 'changed' | null = 'changed'): void {
    store.syncRoutines({
      repository: 'harlan-zw/example',
      specSha,
      entries: [{ name: 'daily-checkin', crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'propose', enabled: true, ...(when === null ? {} : { when }) }],
      at: '2026-08-25T00:00:00.000Z',
    })
  }

  function storeFor(input: { when?: 'changed' | null, takeOwnership?: typeof deployProd } = {}) {
    const store = openJournalStore(':memory:')
    store.syncRepositories([repositoryMapping(input.takeOwnership === undefined ? {} : { takeOwnership: input.takeOwnership })], '2026-08-25T00:00:00.000Z')
    store.setRepositoryWritesEnabled('harlan-zw/example', true)
    sync(store, 'abc123', input.when === undefined ? 'changed' : input.when)
    return store
  }

  function open(store: ReturnType<typeof openJournalStore>, scheduledFor: string, specSha: string): string {
    const run = store.openRoutineRun({ routineId, scheduledFor, specSha, at: new Date(Date.parse(scheduledFor) + 5_000).toISOString() })
    if (run === null)
      throw new Error('Expected a queued Routine run.')
    return run.id
  }

  function settle(store: ReturnType<typeof openJournalStore>, scheduledFor: string, specSha: string, state: 'Completed' | 'Failed'): void {
    open(store, scheduledFor, specSha)
    for (let attempt = 0; attempt < 3; attempt++) {
      const at = new Date(Date.parse(scheduledFor) + (attempt + 1) * 60_000).toISOString()
      const claim = claimStoredRun(store, at)
      const lease = { taskId: claim.id, workerId: claim.state.workerId, fence: claim.state.fence, at }
      if (state === 'Completed') {
        store.completeRoutineRun({ ...lease, evidence: 'daily-checkin on harlan-zw/example | 0 issues requested' })
        return
      }
      if (store.failRoutineRun({ ...lease, reason: 'The provider stopped.' }) === 'Failed')
        return
    }
  }

  const withRuns = (workflowRuns: RoutineGitHubEvidence['workflowRuns']): RoutineGitHubEvidenceSource['collect'] => async () => ({ observedAt: now().toISOString(), issues: { _tag: 'Available', entries: [], truncated: false }, pullRequests: { _tag: 'Available', entries: [], truncated: false }, workflowRuns, deployments: { _tag: 'Available', entries: [], truncated: false }, deploymentStatuses: [], jobLogs: { _tag: 'NotRequested' }, ownership: { _tag: 'NotRequested' } })

  function checkinWorker(store: ReturnType<typeof openJournalStore>, collect: RoutineGitHubEvidenceSource['collect'], capture: { prompts: string[], requests: AgentTurnRequest[], prepared: number }) {
    return createRoutineScanWorker({
      github: { getIssue: async (_repository, number) => ok(issueItem({ number })) },
      writeCheckinEvidence: async () => undefined,
      githubEvidence: { collect },
      logger: { error: () => undefined, info: () => undefined },
      now,
      runtime: () => ({ profile: CODEX_AGENT_PROFILE, provider: scanning({ report: 'GREEN. Production matches yesterday.', candidates: [], verdict: { severity: 'GREEN', coverage: 'complete' } }, capture) }),
      store,
      workspaces: {
        prepareRoutine: async () => {
          capture.prepared += 1
          return ok({ path: '/tmp/routine', baseSha: 'abc123', headSha: 'abc123', defaultBranchSha: 'abc123' })
        },
      },
    })
  }

  async function check(store: ReturnType<typeof openJournalStore>, collect = withRuns({ _tag: 'Unavailable', reason: 'Controller cannot read Actions' })) {
    const capture = { prompts: [] as string[], requests: [] as AgentTurnRequest[], prepared: 0 }
    const result = await checkinWorker(store, collect, capture).run(claimStoredRun(store), new AbortController().signal)
    return { result, turns: capture.requests.length, prepared: capture.prepared }
  }

  it('completes without an Agent turn or report when nothing moved', async () => {
    const store = storeFor()
    try {
      settle(store, yesterday, 'abc123', 'Completed')
      open(store, today, 'abc123')

      expect(await check(store)).toEqual({
        result: {
          _tag: 'Ok',
          value: {
            evidence: `daily-checkin on harlan-zw/example | unchanged since run ${routineId}:${yesterday} | head abc123 | no deploy workflow configured, so head SHA only | no Agent turn | 0 issues requested`,
            usage: { _tag: 'Unavailable' },
          },
        },
        turns: 0,
        prepared: 0,
      })
      expect(store.claimNextRoutineReport('controller-1', now().toISOString(), 60_000)).toBeNull()
    }
    finally {
      store.close()
    }
  })

  it('runs when the default branch moved since the last completed run', async () => {
    const store = storeFor()
    try {
      settle(store, yesterday, 'abc123', 'Completed')
      sync(store, 'def456')
      open(store, today, 'def456')

      expect(await check(store)).toMatchObject({ result: { _tag: 'Ok' }, turns: 1, prepared: 1 })
    }
    finally {
      store.close()
    }
  })

  it('compares with the last completed run, not a newer failed one', async () => {
    const store = storeFor()
    try {
      settle(store, '2026-08-25T07:00:00.000Z', 'abc123', 'Completed')
      sync(store, 'def456')
      settle(store, yesterday, 'def456', 'Failed')
      open(store, today, 'def456')

      expect(await check(store)).toMatchObject({ result: { _tag: 'Ok' }, turns: 1 })
    }
    finally {
      store.close()
    }
  })

  it('runs when no completed run exists to compare with', async () => {
    const store = storeFor()
    try {
      open(store, today, 'abc123')

      expect(await check(store)).toMatchObject({ result: { _tag: 'Ok' }, turns: 1 })
    }
    finally {
      store.close()
    }
  })

  it('runs every scheduled instant when the Routine does not set when', async () => {
    const store = storeFor({ when: null })
    try {
      settle(store, yesterday, 'abc123', 'Completed')
      open(store, today, 'abc123')

      expect(await check(store)).toMatchObject({ result: { _tag: 'Ok' }, turns: 1 })
    }
    finally {
      store.close()
    }
  })

  it('runs a manual check-in even when nothing moved', async () => {
    const store = storeFor()
    try {
      settle(store, yesterday, 'abc123', 'Completed')
      open(store, '2026-08-27T07:03:00.000Z', 'abc123')

      expect(await check(store)).toMatchObject({ result: { _tag: 'Ok' }, turns: 1 })
    }
    finally {
      store.close()
    }
  })

  const deployRun = (createdAt: string) => ({ id: 9, name: 'Deploy to Prod', path: '.github/workflows/deploy-prod.yml', head_sha: 'abc123', head_branch: 'main', status: 'completed', conclusion: 'success', html_url: 'https://github.com/harlan-zw/example/actions/runs/9', created_at: createdAt, updated_at: createdAt })
  const codeRun = { ...deployRun('2026-08-26T12:00:00Z'), id: 8, name: 'Code', path: '.github/workflows/code.yml' }

  it.each([
    { case: 'a deploy after the last completed run', runs: { _tag: 'Available', entries: [codeRun, deployRun('2026-08-26T12:00:00Z')], truncated: false }, turns: 1 },
    { case: 'a deploy evidence read failure', runs: { _tag: 'Unavailable', reason: 'GitHub answered 502.' }, turns: 1 },
    { case: 'a truncated run list without the deploy workflow', runs: { _tag: 'Available', entries: [codeRun], truncated: true }, turns: 1 },
    { case: 'a deploy before the last completed run', runs: { _tag: 'Available', entries: [codeRun, deployRun('2026-08-25T12:00:00Z')], truncated: false }, turns: 0 },
    { case: 'a deploy workflow that never ran on the default branch', runs: { _tag: 'Available', entries: [codeRun], truncated: false }, turns: 0 },
  ] satisfies Array<{ case: string, runs: RoutineGitHubEvidence['workflowRuns'], turns: number }>)('reads $case from the required deploy workflow', async ({ runs, turns }) => {
    const store = storeFor({ takeOwnership: deployProd })
    try {
      settle(store, yesterday, 'abc123', 'Completed')
      open(store, today, 'abc123')

      const checked = await check(store, withRuns(runs))
      expect(checked.turns).toBe(turns)
      if (turns === 0)
        expect(checked.result).toMatchObject({ _tag: 'Ok', value: { evidence: expect.stringContaining('| head abc123 | no deploy-prod.yml run since 2026-08-26T07:00:05.000Z |') } })
    }
    finally {
      store.close()
    }
  })

  it('finds a docs redeploy that left the default branch head where it was', async () => {
    const store = storeFor({ takeOwnership: deployProd })
    try {
      settle(store, yesterday, 'abc123', 'Completed')
      open(store, today, 'abc123')
      const runs = [deployRun('2026-08-26T12:00:00Z')]
      const read = async (path: string) => path.endsWith('/actions/workflows?per_page=100')
        ? ok({ total_count: 1, workflows: [{ id: 5, state: 'active', name: 'Deploy to Prod', path: '.github/workflows/deploy-prod.yml' }] })
        : ok(path.includes('/actions/workflows/5/runs?') ? { workflow_runs: runs } : [])

      expect(await check(store, async (_mapping, _signal, _jobs, workflowBranch) => collectRoutineGitHubEvidence({ repository: 'harlan-zw/example', now, read, ...(workflowBranch === undefined ? {} : { workflowBranch }) })))
        .toMatchObject({ result: { _tag: 'Ok' }, turns: 1 })
    }
    finally {
      store.close()
    }
  })

  it('keeps comparing through stored unchanged runs until a deploy lands', async () => {
    const store = storeFor({ takeOwnership: deployProd })
    try {
      let runs: RoutineGitHubEvidence['workflowRuns'] = { _tag: 'Available', entries: [deployRun('2026-08-23T12:00:00Z')], truncated: false }
      const capture = { prompts: [] as string[], requests: [] as AgentTurnRequest[], prepared: 0 }
      const scheduler = createWorkerTaskScheduler({
        claim: store.claimNextRoutineRun,
        complete: store.completeRoutineRun,
        fail: store.failRoutineRun,
        heartbeat: store.heartbeatRoutineRun,
        intervalMilliseconds: 60_000,
        leaseMilliseconds: 60_000,
        now,
        onError: (error) => { throw error },
        permits: createAgentPermitPool(1),
        worker: checkinWorker(store, async (...input) => withRuns(runs)(...input), capture),
        workerId: 'worker-1',
      })
      for (const day of ['2026-08-24', '2026-08-25', '2026-08-26']) {
        open(store, `${day}T07:00:00.000Z`, 'abc123')
        await scheduler.runNow()
      }
      const [first, second] = [`${routineId}:2026-08-24T07:00:00.000Z`, `${routineId}:2026-08-25T07:00:00.000Z`]

      expect(store.listRoutineRuns(routineId).map(run => ({ state: run.state, usage: run.usage }))).toEqual([
        { state: { _tag: 'Completed', evidence: expect.stringContaining(`| unchanged since run ${second} |`) }, usage: { _tag: 'Unavailable' } },
        { state: { _tag: 'Completed', evidence: expect.stringContaining(`| unchanged since run ${first} |`) }, usage: { _tag: 'Unavailable' } },
        { state: { _tag: 'Completed', evidence: 'daily-checkin on harlan-zw/example | 0 found | 0 new | 0 already known | 0 outside allowed scope | 0 over 5 files | 0 issues requested' }, usage: expect.anything() },
      ])
      expect(capture.requests).toHaveLength(1)
      expect(store.claimNextRoutineReport('controller-1', now().toISOString(), 60_000)?.runId).toBe(first)

      runs = { _tag: 'Available', entries: [deployRun('2026-08-26T12:00:00Z')], truncated: false }
      open(store, today, 'abc123')
      await scheduler.runNow()
      expect(capture.requests).toHaveLength(2)
      await scheduler.stop()
    }
    finally {
      store.close()
    }
  })
})
