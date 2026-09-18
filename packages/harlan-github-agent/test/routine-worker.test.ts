import type { Entry, Questions, SystemOneResult } from 'advocaat'
import type { AgentEvent } from '../src/agent-provider.ts'
import type { ClassificationSource } from '../src/classification.ts'
import type { GitHubIssuePublisher } from '../src/github.ts'
import type { RoutineScanInput } from '../src/routines/contract.ts'
import type { ClaimedRoutineRun } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { createAgentActivityLog } from '../src/agent-activity.ts'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { ok } from '../src/result.ts'
import { createRoutineReportController } from '../src/routine-report-controller.ts'
import { createRoutineScanWorker } from '../src/routine-worker.ts'
import { getRoutine } from '../src/routines/index.ts'
import { openJournalStore } from '../src/store.ts'
import { repositoryMapping } from './fixtures.ts'

const routineScanPrompt = (input: RoutineScanInput) => getRoutine(input.name).scanPrompt(input)

const now = () => new Date('2026-08-27T07:05:00.000Z')

function claimStoredRun(store: ReturnType<typeof openJournalStore>, at = now().toISOString()): ClaimedRoutineRun {
  const task = store.claimNextRoutineRun('worker-1', at, 60 * 60_000)
  if (task === null)
    throw new Error('Expected a queued Routine run.')
  return task
}

function scanning(answer: unknown, capture?: { prompts: string[] }) {
  return {
    name: 'codex' as const,
    runTurn: (request: { prompt: string }) => {
      capture?.prompts.push(request.prompt)
      return (async function* (): AsyncIterable<AgentEvent> {
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
  classification?: ClassificationSource | null,
) {
  return createRoutineScanWorker({
    ...(activityLog === undefined ? {} : { activityLog }),
    ...(classification === undefined ? {} : { classification }),
    logger: { error: () => undefined, info: () => undefined },
    ...(maximumChangedFiles === undefined ? {} : { maximumChangedFiles }),
    now,
    runtime: () => ({ profile: CODEX_AGENT_PROFILE, provider }),
    store,
    workspaces: { prepareRoutine: async () => ok({ path: '/tmp/routine', baseSha: 'abc123', headSha: 'abc123' }) },
  })
}

function worthClassification(dropTitles: string[]): ClassificationSource {
  return {
    classify: <Q extends Questions>(input: { state: Entry }) => Promise.resolve({
      _tag: 'Ok' as const,
      value: {
        model: 'jev-1.13.0',
        answers: { worth: { type: 'choice', choice: dropTitles.includes(String((input.state as { title?: unknown }).title)) ? 'DROP' : 'FILE', confidence: 0.9, probabilities: {} } },
        usage: { input_tokens: 10, output_tokens: 0 },
      } as SystemOneResult<Q>,
    }),
  }
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
  fingerprint: 'src/store.ts#openRoutineRun',
  title: 'Fixture title',
  target: 'src/store.ts',
  claim: 'This helper is never called.',
  verification: 'pnpm test',
  estimatedChangedFiles: 1,
}

describe('building the scan prompt', () => {
  it('drops only the candidate the worth gate refuses and says so in the run line', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'ci-review')
      store.setRepositoryWritesEnabled('harlan-zw/example', true)
      const noise = { ...candidate, fingerprint: 'scripts/alerts.log#count', title: 'Alert count grew by one' }
      const task = claimStoredRun(store)
      const result = await workerFor(store, scanning({ report: 'One real finding.', candidates: [candidate, noise] }), undefined, undefined, worthClassification([noise.title]))
        .run(task, new AbortController().signal)

      expect(result._tag).toBe('Ok')
      if (result._tag !== 'Ok')
        throw new Error(result.error)
      expect(store.listCandidates('harlan-zw/example:ci-review').map(entry => entry.fingerprint)).toEqual([candidate.fingerprint])
      expect(result.value.evidence).toContain('1 dropped by the classification gate')
      expect(result.value.evidence).toContain('1 new')
      expect(result.value.evidence).not.toContain('2 new')
    }
    finally {
      store.close()
    }
  })

  it('keeps every candidate when the worth gate fails', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store, 'ci-review')
      store.setRepositoryWritesEnabled('harlan-zw/example', true)
      const task = claimStoredRun(store)
      const failing: ClassificationSource = {
        classify: () => Promise.resolve({ _tag: 'Err' as const, error: { _tag: 'Unavailable' as const, message: 'down' } }),
      }
      const result = await workerFor(store, scanning({ report: 'Findings.', candidates: [candidate] }), undefined, undefined, failing)
        .run(task, new AbortController().signal)

      expect(result._tag).toBe('Ok')
      if (result._tag !== 'Ok')
        throw new Error(result.error)
      expect(store.listCandidates('harlan-zw/example:ci-review').map(entry => entry.fingerprint)).toEqual([candidate.fingerprint])
      expect(result.value.evidence).not.toContain('dropped by the classification gate')
    }
    finally {
      store.close()
    }
  })

  it('keeps Agent feedback proposals inside one skill file', () => {
    expect(getRoutine('agent-feedback').selectCandidates([
      { ...candidate, target: 'src/controller.ts' },
      { ...candidate, fingerprint: 'skill-a', target: 'harlan-agent-kit/skills/adversarial-review/SKILL.md' },
      { ...candidate, fingerprint: 'skill-b', target: 'harlan-agent-kit/skills/pr-triage/SKILL.md' },
    ])).toEqual([{ ...candidate, fingerprint: 'skill-a', target: 'harlan-agent-kit/skills/adversarial-review/SKILL.md' }])
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
  ])('leaves a $_tag Candidate out of the next scan memory', (result) => {
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

    expect(prompt).not.toContain('src/closed.ts')
    expect(prompt).toContain('Nothing has been rejected yet.')
  })

  it('tells a report routine that nothing it proposes gets built', () => {
    const prompt = routineScanPrompt({ mode: 'report', name: 'pr-triage', priorCandidates: [], repository: 'harlan-zw/example' })

    expect(prompt).toContain('reports only')
  })
})

describe('running one scan', () => {
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
        findOpenIssueByFingerprint: async () => ok(null),
        findRoutineTrackingIssue: async () => ok(null),
        findIssueCommentByMarker: async () => ok(null),
      }
      await createRoutineReportController({ github, now, store, workerId: 'reporter' })
        .publishPending(new AbortController().signal)

      expect(calls.issues).toEqual(['[BLOCKED] Daily check-in: 2026-08-27'])
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

  it('retries a failed run until its attempts run out', () => {
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
          reason: 'The scan agent failed.',
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
