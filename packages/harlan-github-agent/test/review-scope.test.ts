import type { RepairDelta } from '../src/review-scope.ts'
import type { ClaimedAdversarialReviewTask, RecordReviewRunInput, RepositoryAutoMergeScope, ReviewFinding, ReviewGates, ReviewRun } from '../src/types.ts'
import type { ProviderCapture } from './fixtures.ts'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { createReviewWorker, reviewOutcome } from '../src/item-agent.ts'
import { ok } from '../src/result.ts'
import { repairFocusCoverage, repairFocusScope, repairFocusSource } from '../src/review-scope.ts'
import { createReviewStaticReader } from '../src/review-static.ts'
import { openJournalStore } from '../src/store.ts'
import { readRepairDelta } from '../src/worktree.ts'
import { agentRuntime, agentTurnLedger, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

const temporaryDirectories: string[] = []

afterEach(() => temporaryDirectories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], { encoding: 'utf8' }).trim()
}

function commitFile(directory: string, path: string, content: string, message: string): string {
  writeFileSync(join(directory, path), content)
  git(directory, 'add', path)
  git(directory, 'commit', '-q', '-m', message)
  return git(directory, 'rev-parse', 'HEAD')
}

/** A pull request branch whose head `reviewed` has a Review that Repair answered. */
function repositoryWithReviewedHead() {
  const directory = mkdtempSync(join(tmpdir(), 'harlan-review-scope-'))
  temporaryDirectories.push(directory)
  execFileSync('git', ['init', '-q', '-b', 'main', directory])
  git(directory, 'config', 'user.email', 'agent@example.com')
  git(directory, 'config', 'user.name', 'Agent Test')
  commitFile(directory, 'shared.txt', 'one\n', 'base')
  git(directory, 'switch', '-q', '-c', 'feature')
  commitFile(directory, 'parser.ts', 'export const limit = 1\n', 'feature')
  const reviewed = commitFile(directory, 'caller.ts', 'import { limit } from \'./parser\'\n', 'caller')
  return { directory, reviewed }
}

describe('readRepairDelta', () => {
  it('reads the diff and paths of the Repair commits since the reviewed head', async () => {
    const { directory, reviewed } = repositoryWithReviewedHead()
    const headSha = commitFile(directory, 'parser.ts', 'export const limit = 2\n', 'repair')

    const delta = await readRepairDelta(directory, { sourceHeadSha: reviewed, headSha }, 32_000, AbortSignal.timeout(10_000))

    expect(delta).toMatchObject({ _tag: 'Ok', value: { _tag: 'Diff', paths: ['parser.ts'] } })
    const diff = delta._tag === 'Ok' && delta.value._tag === 'Diff' ? delta.value.diff : ''
    expect(diff).toContain('-export const limit = 1')
    expect(diff).toContain('+export const limit = 2')
    expect(diff).not.toContain('caller.ts')
  })

  it('reads a branch that no longer contains the reviewed head as rewritten', async () => {
    const { directory, reviewed } = repositoryWithReviewedHead()
    git(directory, 'reset', '-q', '--hard', 'HEAD~1')
    const headSha = commitFile(directory, 'parser.ts', 'export const limit = 2\n', 'rewritten')

    const delta = await readRepairDelta(directory, { sourceHeadSha: reviewed, headSha }, 32_000, AbortSignal.timeout(10_000))

    expect(delta).toEqual({ _tag: 'Ok', value: { _tag: 'Rewritten' } })
  })

  it('reads a merge after the reviewed head as one the focus cannot cover', async () => {
    const { directory, reviewed } = repositoryWithReviewedHead()
    git(directory, 'switch', '-q', 'main')
    commitFile(directory, 'main-only.txt', 'main\n', 'main moves')
    git(directory, 'switch', '-q', 'feature')
    execFileSync('git', ['-C', directory, 'merge', '-q', '--no-edit', 'main'], { stdio: 'ignore' })
    const headSha = commitFile(directory, 'parser.ts', 'export const limit = 2\n', 'repair')

    const delta = await readRepairDelta(directory, { sourceHeadSha: reviewed, headSha }, 32_000, AbortSignal.timeout(10_000))

    expect(delta).toEqual({ _tag: 'Ok', value: { _tag: 'IncludesMerge' } })
  })

  it('reads a delta over the character budget as too large, without its text', async () => {
    const { directory, reviewed } = repositoryWithReviewedHead()
    const headSha = commitFile(directory, 'parser.ts', `${'export const limit = 2\n'.repeat(40)}`, 'large repair')

    const delta = await readRepairDelta(directory, { sourceHeadSha: reviewed, headSha }, 200, AbortSignal.timeout(10_000))

    expect(delta).toMatchObject({ _tag: 'Ok', value: { _tag: 'TooLarge' } })
  })
})

function gates(review: ReviewGates['review'] = { _tag: 'Passed', evidence: [] }): ReviewGates {
  return {
    merge: { _tag: 'Passed', evidence: [] },
    review,
    ci: { _tag: 'Passed', evidence: [] },
  }
}

const targeted: ReviewFinding = {
  _tag: 'Open',
  impact: 88,
  summary: 'Limit rejects valid input',
  nextAction: 'Raise the limit.',
  resolution: 'Repair',
  details: { fingerprint: 'a'.repeat(64), identity: 'limit-rejects-valid-input', location: { path: 'parser.ts', line: 1 }, proof: 'A value of 2 fails.', regressionTest: 'Parse a value of 2.' },
}

const logged: ReviewFinding = {
  _tag: 'Logged',
  impact: 40,
  summary: 'Caller ignores the limit',
  nextAction: 'Read the limit in the caller.',
  details: { fingerprint: 'b'.repeat(64), identity: 'caller-ignores-limit', location: { path: 'caller.ts', line: 1 }, proof: 'The caller never reads it.' },
}

function sourceRun(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    gatePublication: { _tag: 'Unpublished' },
    baseRef: 'main',
    id: 'source-run',
    repository: 'harlan-zw/example',
    pullRequestNumber: 24,
    revisionId: 'revision-1',
    headSha: 'abc1234def',
    provider: 'codex',
    sessionId: 'session-source',
    model: 'gpt-6.2-sol',
    agentVersion: '0.0.0',
    skillDigest: 'f'.repeat(64),
    startedAt: '2026-11-24T00:00:00.000Z',
    completedAt: '2026-11-24T00:05:00.000Z',
    usage: { _tag: 'Unavailable' },
    gates: gates({ _tag: 'Failed', reason: 'A bug.', evidence: [] }),
    outcome: { _tag: 'Blocked', confidence: 70 },
    findings: [targeted, logged],
    feedback: null,
    publications: [],
    ...overrides,
  }
}

const sensitiveRisk: NonNullable<ReviewRun['mergeRisk']> = {
  claim: { _tag: 'Sensitive', reason: 'The parser limit is a published default.' },
  floor: { _tag: 'Reviewable', reason: 'Not on a contained path.' },
  combined: { _tag: 'Sensitive', reason: 'The parser limit is a published default.' },
}

const repairDiff = 'diff --git a/parser.ts b/parser.ts\n-export const limit = 1\n+export const limit = 2\n'
const repairDelta: RepairDelta = { _tag: 'Diff', diff: repairDiff, paths: ['parser.ts'] }

describe('repairFocusSource', () => {
  it('names the Review a Repair answered, while it is still the current Review of an earlier head', () => {
    const source = sourceRun()

    expect(repairFocusSource({ forced: false, repair: { headSha: source.headSha, builtOnHeadSha: source.headSha }, earlier: source }))
      .toEqual({ _tag: 'Ok', value: source })
  })

  it.each<[string, Parameters<typeof repairFocusSource>[0]]>([
    ['a requested rerun', { forced: true, repair: { headSha: 'abc1234def', builtOnHeadSha: 'abc1234def' }, earlier: sourceRun() }],
    ['a head no Repair pushed', { forced: false, repair: null, earlier: sourceRun() }],
    ['a Repair built on another head', { forced: false, repair: { headSha: 'abc1234def', builtOnHeadSha: 'later99' }, earlier: sourceRun() }],
    ['no current Review of an earlier head', { forced: false, repair: { headSha: 'abc1234def', builtOnHeadSha: 'abc1234def' }, earlier: undefined }],
    ['a newer Review than the one Repair answered', { forced: false, repair: { headSha: 'abc1234def', builtOnHeadSha: 'abc1234def' }, earlier: sourceRun({ headSha: 'later99' }) }],
  ])('reviews the full diff after %s', (_case, input) => {
    expect(repairFocusSource(input)._tag).toBe('Err')
  })
})

describe('repairFocusScope', () => {
  it('focuses a Review on a readable Repair delta', () => {
    const source = sourceRun()

    expect(repairFocusScope(source, repairDelta)).toEqual({ _tag: 'RepairFocus', source, diff: repairDiff, paths: ['parser.ts'] })
  })

  it.each<[string, RepairDelta | null]>([
    ['Git could not read the delta', null],
    ['the branch was rewritten', { _tag: 'Rewritten' }],
    ['a merge came in', { _tag: 'IncludesMerge' }],
    ['the delta is over budget', { _tag: 'TooLarge', characters: 90_000 }],
    ['the delta is empty', { _tag: 'Diff', diff: '', paths: [] }],
  ])('reviews the full diff when %s', (_case, delta) => {
    expect(repairFocusScope(sourceRun(), delta)._tag).toBe('Full')
  })
})

describe('repairFocusCoverage', () => {
  it('names the head the focus started from', () => {
    expect(repairFocusCoverage('the limit in parser.ts and its caller.', 'abc1234def'))
      .toBe('the limit in parser.ts and its caller; focused on the Repair delta since abc1234, with the full diff available')
  })
})

const containedScope: RepositoryAutoMergeScope = {
  _tag: 'Contained',
  labelOverridesRisk: true,
  minimumConfidence: 90,
  policy: { containedPaths: [], maximumChangedFiles: 12, maximumChangedLines: 300, requireTestChange: false, sensitivePaths: [] },
}

const passingCheck = { id: 1, failure: { _tag: 'NotAsked' as const }, source: { _tag: 'CheckRun' as const, appId: 15368 }, name: 'test', status: 'completed', conclusion: 'success' }

/**
 * Runs one Review of a Repair head and reports the prompt the Agent received
 * and what the Review run recorded.
 */
async function reviewRepairHead(input: { source: ReviewRun, callerVerification?: 'complete' | 'incomplete' | null | ((prompt: string) => 'complete' | 'incomplete'), findings?: { identity: string, impact: number, line: number, nextAction: string, path: string, proof: string, regressionTest: string, summary: string }[], notChecked?: string | null, paths?: string[], task?: ClaimedAdversarialReviewTask, journal?: ReturnType<typeof openJournalStore>, rerun?: boolean, repaired?: boolean, delta?: RepairDelta, mergeRisk?: { verdict: 'contained' | 'reviewable' | 'sensitive', reason: string } }) {
  const pullRequest = pullRequestItem({ mergeState: 'clean', ...input.task?.pullRequest })
  const capture: ProviderCapture = { requests: [] }
  const recorded: RecordReviewRunInput[] = []
  const publications: string[] = []
  const worker = createReviewWorker({
    runtime: agentRuntime(CODEX_AGENT_PROFILE, {
      name: 'codex',
      runTurn: request => stubProvider(turnEvents({
        checked: 'the limit in parser.ts and its caller',
        notChecked: input.notChecked ?? null,
        ...(input.callerVerification === null ? {} : { callerVerification: typeof input.callerVerification === 'function' ? input.callerVerification(request.prompt) : input.callerVerification ?? 'complete' }),
        premise: { verdict: 'sound', reason: 'The change keeps its intent.' },
        findings: input.findings ?? [],
        confidence: 96,
        ...(input.mergeRisk === undefined ? {} : { mergeRisk: input.mergeRisk }),
      }), capture).runTurn(request),
    }),
    github: {
      consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
      editReviewStatus: () => Promise.reject(new Error('Unexpected comment edit.')),
      ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
      clearAgentLabels: () => Promise.reject(new Error('Unexpected label clear.')),
      clearRunningLabel: () => Promise.reject(new Error('Unexpected Running label clear.')),
      listRunningLabelledItems: () => Promise.reject(new Error('Unexpected Running label read.')),
      stampAgentLabel: () => Promise.resolve(ok(undefined)),
      upsertReviewCheckRun: () => Promise.reject(new Error('Unexpected Review check run write.')),
      findOpenPullRequestForBranch: () => Promise.reject(new Error('Unexpected pull request lookup.')),
      getFailedJobContext: () => Promise.reject(new Error('Unexpected job log read.')),
      getIssueTriageSnapshot: () => Promise.reject(new Error('Unexpected issue request.')),
      getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
      listPullRequestFiles: () => Promise.reject(new Error('The recorded files must answer.')),
      getPullRequestReviewSnapshot: () => Promise.resolve(ok({
        baseChecks: { _tag: 'Available', checks: [passingCheck] },
        body: 'Fixes the bug.',
        checks: { _tag: 'Available', checks: [passingCheck] },
        comments: [],
        priorAutomatedReview: { _tag: 'None' },
        pullRequest,
        findingDiscussions: [],
        requiredChecks: { _tag: 'None' },
        reviews: [],
      })),
      upsertIssueTriageComment: () => Promise.reject(new Error('Review must not post issue triage.')),
      upsertReviewStatus: () => Promise.reject(new Error('The Worker must use the status controller.')),
    },
    now: () => new Date('2026-11-24T01:00:00.000Z'),
    preflightRepair: () => Promise.resolve(ok(undefined)),
    store: {
      recordExactPullRequestObservation: () => { throw new Error('Unexpected merge observation.') },
      queueReviewFixTaskForReview: () => { throw new Error('A clean review must not queue Repair work.') },
      getRepairedHeadFindings: () => [targeted],
      repairRoundPlan: () => ({ _tag: 'Allowed' as const, number: 2 }),
      getWorkerSession: () => null,
      storedReviewForHead: () => ({ _tag: 'None' }),
      getRevisionFiles: () => ({ files: [{ path: 'parser.ts', status: 'modified' as const, additions: 4, deletions: 2, previousFilename: null }, { path: 'caller.ts', status: 'added' as const, additions: 1, deletions: 0, previousFilename: null }].filter(file => input.paths === undefined || input.paths.includes(file.path)), headSha: pullRequest.headSha }),
      supersedeReviewRun: input => ({ _tag: 'Inserted', reviewRunId: input.id }),
      recordIncident: () => { throw new Error('Unexpected Incident.') },
      queueBaselineRepairForReview: () => { throw new Error('Healthy base CI must not queue Baseline repair.') },
      retireBaselineRepairForReview: () => 0,
      saveWorkerSession: () => undefined,
      ...agentTurnLedger,
      updateAgentProgress: () => true,
      priorReviewHistory: () => ({ _tag: 'FirstReview' as const }),
      latestReviewOfEarlierHead: () => input.source,
      repairSource: revisionId => input.repaired === false || revisionId === input.source.revisionId ? null : { headSha: input.source.headSha, builtOnHeadSha: input.source.headSha, fingerprints: ['a'.repeat(64)] },
      mergedWithFailingChecks: () => null,
      recordReviewRun: (run) => {
        recorded.push(run)
        return { _tag: 'Inserted', reviewRunId: run.id }
      },
      recordReviewPublication: publication => ({ _tag: 'Inserted', publicationId: publication.id }),
      ...(input.journal === undefined
        ? {}
        : {
            repairSource: input.journal.repairSource,
            latestReviewOfEarlierHead: input.journal.latestReviewOfEarlierHead,
            getRepairedHeadFindings: input.journal.getRepairedHeadFindings,
            queueReviewFixTaskForReview: input.journal.queueReviewFixTaskForReview,
            recordReviewRun: (run) => {
              recorded.push(run)
              return input.journal!.recordReviewRun(run)
            },
          }),
    },
    status: {
      publish: (_task, _phase, body) => {
        publications.push(body)
        return Promise.resolve(ok({ commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' }))
      },
    },
    triageStatus: { publish: () => Promise.reject(new Error('Review must not publish issue triage.')) },
    workspaces: {
      prepareIssue: () => Promise.reject(new Error('Unexpected issue workspace.')),
      prepareReview: () => Promise.resolve(ok({ path: '/tmp/review-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
      verifyReview: () => Promise.resolve(ok(undefined)),
      readHeadAdvance: () => Promise.resolve(ok({ _tag: 'NewCommits' as const })),
      readRepairDelta: (_worktree, sourceHeadSha) => sourceHeadSha === input.source.headSha
        ? Promise.resolve(ok(input.delta ?? repairDelta))
        : Promise.reject(new Error('The delta must start at the head the Repair answered.')),
    },
  })

  const result = await worker.run(input.task ?? {
    id: 'review-task',
    kind: 'adversarial_review',
    repository: 'harlan-zw/example',
    pullRequestNumber: 24,
    revisionId: 'revision-2',
    state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-11-24T02:00:00.000Z' },
    updatedAt: '2026-11-24T01:00:00.000Z',
    repositoryMapping: repositoryMapping({ autoMerge: containedScope }),
    pullRequest,
    rerun: input.rerun === true ? { _tag: 'Requested' } : { _tag: 'NotRequested' },
  }, new AbortController().signal)

  if (result._tag !== 'Ok')
    throw new Error(result.error)
  const prompt = capture.requests.at(0)?.prompt
  if (prompt === undefined)
    throw new Error('Expected one Agent turn.')
  return { prompt, run: recorded.at(0), publication: publications.at(-1) }
}

const fullDiffMandate = 'Follow nextOffset until truncated is false.'

describe('a Review of a Repair head', () => {
  it.each([false, true])('keeps earlier callers in scope across two Repairs, all callers verified: %s', async (allCallersVerified) => {
    const store = openJournalStore(':memory:')
    let second = 0
    const at = () => `2026-11-24T00:10:${String(second++).padStart(2, '0')}.000Z`
    const unrelated = {
      identity: 'unrelated-blocker',
      impact: 88,
      line: 1,
      nextAction: 'Fix the unrelated bug.',
      path: 'other.ts',
      proof: 'The unrelated operation fails.',
      regressionTest: 'Call the unrelated operation.',
      summary: 'An unrelated operation fails',
    }
    const publishRepair = (review: ClaimedAdversarialReviewTask, headSha: string) => {
      expect(['Queued', 'Existing']).toContain(store.queueReviewFixTaskForReview({ taskId: review.id, workerId: review.state.workerId, fence: review.state.fence, at: at() })._tag)
      const repair = store.claimNextReviewFixTask('repairer', at(), 60_000)!
      expect(store.stagePublication({
        taskId: repair.id,
        workerId: repair.state.workerId,
        fence: repair.state.fence,
        at: at(),
        publication: { _tag: 'UpdatePullRequest', taskKind: 'review_fix', baseRef: 'main', pullRequestNumber: 24, commitSha: headSha, baseSha: repair.pullRequest.baseSha, expectedHeadSha: repair.pullRequest.headSha, headRef: repair.pullRequest.headRef, artifactRef: 'refs/test/repair', patchDigest: 'repair-patch', changedFiles: 1 },
      })._tag).toBe('Staged')
      const publication = store.claimNextPublication('publisher', at(), 60_000)!
      expect(store.completePublication({ commandId: publication.id, workerId: publication.workerId, fence: publication.fence, at: at(), evidence: 'Published Repair.' })).toBe(true)
      expect(store.recordObservation({ externalId: headSha, observedAt: at(), source: 'poll', subject: pullRequestItem({ ...review.pullRequest, headSha }) })._tag).toBe('Inserted')
      return store.claimNextAdversarialReviewTask('reviewer', at(), 60_000)!
    }
    try {
      store.syncRepositories([repositoryMapping()], at())
      store.recordObservation({ externalId: 'source', observedAt: at(), source: 'poll', subject: pullRequestItem({ mergeState: 'clean' }) })
      const initial = store.claimNextAdversarialReviewTask('reviewer', at(), 60_000)!
      expect(store.recordReviewRun({ ...sourceRun(), revisionId: initial.revisionId, headSha: initial.pullRequest.headSha })._tag).toBe('Inserted')
      const firstTask = publishRepair(initial, 'e'.repeat(40))
      const first = await reviewRepairHead({
        task: firstTask,
        journal: store,
        source: store.latestReviewOfEarlierHead(initial.repository, 24, firstTask.pullRequest.headSha)!,
        callerVerification: 'incomplete',
        notChecked: 'The API Repair has unverified callers.',
        findings: [unrelated],
      })
      expect(first.run?.gates.review._tag).toBe('Failed')
      const secondTask = publishRepair(firstTask, 'f'.repeat(40))
      const next = await reviewRepairHead({
        task: secondTask,
        journal: store,
        source: store.latestReviewOfEarlierHead(initial.repository, 24, secondTask.pullRequest.headSha)!,
        delta: { _tag: 'Diff', paths: ['other.ts'], diff: 'diff --git a/other.ts b/other.ts\n-broken()\n+fixed()\n' },
        // This Agent verified the latest delta. A full Review also asks it
        // about the earlier API callers, which remain unverified in one case.
        callerVerification: prompt => allCallersVerified || !prompt.includes(fullDiffMandate) ? 'complete' : 'incomplete',
        notChecked: allCallersVerified ? null : 'The earlier API callers remain unverified.',
      })
      expect(reviewOutcome(next.run!.gates)).toBe(allCallersVerified ? 'READY' : 'PENDING')
      expect(next.prompt).toContain(fullDiffMandate)
      expect(next.prompt).toContain('This full Review covers a Repair head. Verify every affected caller')
    }
    finally { store.close() }
  })

  it('withholds Ready when caller verification remains incomplete after a truncated search', async () => {
    const review = await reviewRepairHead({
      source: sourceRun(),
      callerVerification: 'incomplete',
      notChecked: 'affected callers after review_search returned truncated: true',
    })

    expect(review.run?.gates.merge._tag).toBe('Passed')
    expect(review.run?.gates.ci._tag).toBe('Passed')
    expect(review.run?.findings).toEqual([])
    expect(reviewOutcome(review.run!.gates)).toBe('PENDING')
    expect(review.publication).toContain('affected callers after review_search returned truncated: true')
    expect(review.publication).not.toContain('the review passed')
  })

  it.each([
    { callerVerification: null, notChecked: null },
    { callerVerification: 'incomplete' as const, notChecked: null },
  ])('withholds Ready for missing or incomplete caller verification: %j', async (coverage) => {
    const review = await reviewRepairHead({ source: sourceRun(), ...coverage })

    expect(reviewOutcome(review.run!.gates)).toBe('PENDING')
  })

  it('allows Ready when caller verification is complete and nothing was skipped', async () => {
    const review = await reviewRepairHead({ source: sourceRun(), callerVerification: 'complete' })

    expect(reviewOutcome(review.run!.gates)).toBe('READY')
  })

  it('allows Ready when callers are verified and the largest gap is elsewhere', async () => {
    // Every Review names some gap: notChecked was set on all 147 Reviews in the
    // week to 2026-11-24. Only a new Review moves a Pending review gate, so
    // gating on any gap would hold every Repair head at Pending.
    const review = await reviewRepairHead({ source: sourceRun(), callerVerification: 'complete', notChecked: 'the dashboard in a browser' })

    expect(reviewOutcome(review.run!.gates)).toBe('READY')
  })

  it.each([null, 'incomplete'] as const)('keeps unverified callers Pending after a full rerun: %s', async (callerVerification) => {
    const source = sourceRun()
    const first = await reviewRepairHead({ source, callerVerification: 'incomplete', notChecked: 'unchanged callers beyond byte 16000' })
    expect(reviewOutcome(first.run!.gates)).toBe('PENDING')

    const rerun = await reviewRepairHead({ source, rerun: true, callerVerification })

    expect(rerun.run?.headSha).toBe(first.run?.headSha)
    expect(rerun.run?.findings).toEqual([])
    expect(reviewOutcome(rerun.run!.gates)).toBe('PENDING')
  })

  it('allows a full rerun to clear caller verification after verifying affected callers', async () => {
    const review = await reviewRepairHead({ source: sourceRun(), rerun: true, callerVerification: 'complete', notChecked: 'the dashboard in a browser' })

    expect(reviewOutcome(review.run!.gates)).toBe('READY')
    expect(review.prompt).toContain(fullDiffMandate)
    expect(review.prompt).toContain('Return callerVerification as complete only after verifying every affected caller')
  })

  it('keeps ordinary full Review coverage gaps outside the caller gate', async () => {
    const review = await reviewRepairHead({ source: sourceRun(), repaired: false, rerun: true, callerVerification: null, notChecked: 'the dashboard in a browser' })

    expect(reviewOutcome(review.run!.gates)).toBe('READY')
  })

  it('requires unchanged caller verification when bounded search misses a use beyond byte 16000', async () => {
    const { directory } = repositoryWithReviewedHead()
    git(directory, 'switch', '-q', 'main')
    commitFile(directory, 'parser.ts', 'export const limit = (value: number) => value\n', 'original callee')
    const baseSha = commitFile(directory, 'caller.ts', `${'// padding\n'.repeat(1700)}import { limit } from './parser'\nexport const result = limit(1)\n`, 'original caller')
    git(directory, 'switch', '-q', '-C', 'feature')
    const reviewed = commitFile(directory, 'parser.ts', 'export const limit = (value: number) => value + 1\n', 'change callee')
    const headSha = commitFile(directory, 'parser.ts', 'export const limit = (value: { count: number }) => value.count + 1\n', 'repair callee')
    const paths = git(directory, 'diff', '--name-only', `${baseSha}...${headSha}`).split('\n')
    expect(paths).toEqual(['parser.ts'])
    const delta = await readRepairDelta(directory, { sourceHeadSha: reviewed, headSha }, 32_000, AbortSignal.timeout(10_000))
    if (delta._tag !== 'Ok')
      throw new Error(delta.error)
    const reader = createReviewStaticReader(directory)
    expect(await reader.search('limit(1)')).toEqual({ _tag: 'Matches', matches: [], truncated: true })
    const caller = await reader.read('caller.ts', 16_000)
    expect(caller).toMatchObject({ _tag: 'Read', truncated: false })
    if (caller._tag === 'Read')
      expect(caller.text).toContain('limit(1)')

    const review = await reviewRepairHead({ source: sourceRun({ headSha: reviewed }), delta: delta.value, paths })

    expect(review.prompt).toContain('If it returns truncated: true or refuses the search, its matches are incomplete, and zero matches prove nothing.')
    expect(review.prompt).toContain('including unchanged callers and dependants outside the pull request files')
    expect(review.prompt).toContain('Use revision workspace for unchanged files')
    expect(review.prompt).toContain('If caller coverage cannot be established, perform a full Review with explicit caller verification')
    expect(review.prompt).toContain('If caller verification remains unavailable, report the verification limit.')
  })

  it.each([false, true])('uses the published Repair delta unless a full Review was explicitly requested: %s', async (explicit) => {
    const store = openJournalStore(':memory:')
    const at = (second: number) => `2026-11-24T00:10:${String(second).padStart(2, '0')}.000Z`
    try {
      store.syncRepositories([repositoryMapping()], at(0))
      const observed = store.recordObservation({ externalId: 'source', observedAt: at(1), source: 'poll', subject: pullRequestItem({ mergeState: 'clean' }) })
      if (observed._tag !== 'Inserted')
        throw new Error('Expected a source Revision.')
      const review = store.claimNextAdversarialReviewTask('reviewer', at(2), 60_000)!
      expect(store.recordReviewRun({ ...sourceRun(), revisionId: observed.revisionId, headSha: review.pullRequest.headSha })._tag).toBe('Inserted')
      expect(store.queueReviewFixTaskForReview({ taskId: review.id, workerId: review.state.workerId, fence: review.state.fence, at: at(3) })._tag).toBe('Queued')
      const repair = store.claimNextReviewFixTask('repairer', at(4), 60_000)!
      const headSha = 'e'.repeat(40)
      expect(store.stagePublication({
        taskId: repair.id,
        workerId: repair.state.workerId,
        fence: repair.state.fence,
        at: at(5),
        publication: { _tag: 'UpdatePullRequest', taskKind: 'review_fix', baseRef: 'main', pullRequestNumber: 24, commitSha: headSha, baseSha: repair.pullRequest.baseSha, expectedHeadSha: repair.pullRequest.headSha, headRef: repair.pullRequest.headRef, artifactRef: 'refs/test/repair', patchDigest: 'repair-patch', changedFiles: 1 },
      })._tag).toBe('Staged')
      const publication = store.claimNextPublication('publisher', at(6), 60_000)!
      expect(store.completePublication({ commandId: publication.id, workerId: publication.workerId, fence: publication.fence, at: at(7), evidence: 'Published Repair.' })).toBe(true)
      const repaired = store.recordObservation({ externalId: 'repaired', observedAt: at(8), source: 'poll', subject: pullRequestItem({ ...review.pullRequest, headSha, updatedAt: at(8) }) })
      if (repaired._tag !== 'Inserted')
        throw new Error('Expected a repaired Revision.')
      if (explicit)
        expect(store.requestReviewRerun({ repository: review.repository, pullRequestNumber: 24, revisionId: repaired.revisionId, requestId: 'explicit', source: 'dashboard', requestedBy: 'harlan-zw', at: at(9) })._tag).toBe('AlreadyQueued')
      const task = store.claimNextAdversarialReviewTask('follow-up', at(10), 60_000)!
      const source = store.latestReviewOfEarlierHead(task.repository, 24, headSha)!
      const result = await reviewRepairHead({ task, source, journal: store })
      if (explicit) {
        expect(result.prompt).toContain(fullDiffMandate)
        expect(result.prompt).not.toContain(repairDiff)
      }
      else {
        expect(result.prompt).toContain(repairDiff)
        expect(result.run?.checked).toContain('focused on the Repair delta')
      }
    }
    finally {
      store.close()
    }
  })

  it('hands the Agent the Repair delta as its focus, with the full diff still readable', async () => {
    const review = await reviewRepairHead({ source: sourceRun() })

    expect(review.prompt).toContain(repairDiff)
    expect(review.prompt).toContain('abc1234def')
    expect(review.prompt).toContain('review_read with revision diff and an empty path')
    expect(review.prompt).toContain('review_search')
    expect(review.prompt).toContain('caller.ts')
    expect(review.prompt).not.toContain(fullDiffMandate)
  })

  it('asks the Agent to recheck the earlier Review\'s other findings by their identity', async () => {
    const review = await reviewRepairHead({ source: sourceRun() })

    expect(review.prompt).toContain('caller-ignores-limit')
    expect(review.prompt).toContain('limit-rejects-valid-input')
  })

  it('records only what this turn answered, never the earlier Review\'s findings or confidence', async () => {
    const review = await reviewRepairHead({ source: sourceRun() })

    expect(review.run).toMatchObject({
      findings: [],
      confidence: 96,
      checked: 'the limit in parser.ts and its caller; focused on the Repair delta since abc1234, with the full diff available',
    })
  })

  it('asks the Agent to answer Merge risk for the whole pull request, starting from the answered Review\'s claim', async () => {
    const review = await reviewRepairHead({ source: sourceRun({ mergeRisk: sensitiveRisk }) })

    expect(review.prompt).toContain('for the whole pull request')
    expect(review.prompt).toContain('merge risk sensitive')
  })

  it('never claims a lower Merge risk than the Review it answered, since it did not reread the whole diff', async () => {
    const review = await reviewRepairHead({ source: sourceRun({ mergeRisk: sensitiveRisk }), mergeRisk: { verdict: 'contained', reason: 'One small file.' } })

    expect(review.run?.mergeRisk?.claim).toEqual(sensitiveRisk.claim)
  })

  it('keeps a higher Merge risk the delta itself adds', async () => {
    const review = await reviewRepairHead({ source: sourceRun({ mergeRisk: { claim: { _tag: 'Contained' }, floor: { _tag: 'Contained' }, combined: { _tag: 'Contained' } } }), mergeRisk: { verdict: 'sensitive', reason: 'The Repair changes a shared default.' } })

    expect(review.run?.mergeRisk?.claim).toEqual({ _tag: 'Sensitive', reason: 'The Repair changes a shared default.' })
  })

  it('records a policy digest of its own, so a focused run is told apart from a full one', async () => {
    const focused = await reviewRepairHead({ source: sourceRun() })
    const full = await reviewRepairHead({ source: sourceRun(), repaired: false })

    expect(focused.run?.skillDigest).toMatch(/^[a-f\d]{64}$/)
    expect(focused.run?.skillDigest).not.toBe(full.run?.skillDigest)
  })

  it.each<[string, Parameters<typeof reviewRepairHead>[0]]>([
    ['a requested rerun', { source: sourceRun(), rerun: true }],
    ['a head no Repair pushed', { source: sourceRun(), repaired: false }],
    ['a Repair delta over budget', { source: sourceRun(), delta: { _tag: 'TooLarge', characters: 90_000 } }],
  ])('reviews the full diff after %s', async (_case, input) => {
    const review = await reviewRepairHead(input)

    expect(review.prompt).toContain(fullDiffMandate)
    expect(review.prompt).not.toContain(repairDiff)
    expect(review.run).toMatchObject({ checked: 'the limit in parser.ts and its caller' })
  })
})
