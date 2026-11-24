import type { HeadAdvance } from '../src/review-reuse.ts'
import type { ClaimedAdversarialReviewTask, RecordReviewRunInput, ReviewFinding, ReviewGates, ReviewRun } from '../src/types.ts'
import type { ProviderCapture } from './fixtures.ts'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { createReviewWorker } from '../src/item-agent.ts'
import { ok } from '../src/result.ts'
import { carriedCoverage, decideReviewReuse } from '../src/review-reuse.ts'
import { openJournalStore } from '../src/store.ts'
import { readHeadAdvance } from '../src/worktree.ts'
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

/**
 * A pull request branch reviewed at `reviewed`, while `main` moved on.
 *
 * `shared.txt` is the file both sides edit when a test needs a conflict.
 */
function repositoryWithReviewedHead() {
  const directory = mkdtempSync(join(tmpdir(), 'harlan-review-reuse-'))
  temporaryDirectories.push(directory)
  execFileSync('git', ['init', '-q', '-b', 'main', directory])
  git(directory, 'config', 'user.email', 'agent@example.com')
  git(directory, 'config', 'user.name', 'Agent Test')
  commitFile(directory, 'shared.txt', 'one\n', 'base')
  git(directory, 'switch', '-q', '-c', 'feature')
  const reviewed = commitFile(directory, 'feature.txt', 'feature\n', 'feature')
  git(directory, 'switch', '-q', 'main')
  return { directory, reviewed }
}

function mergeMain(directory: string): string {
  git(directory, 'switch', '-q', 'feature')
  execFileSync('git', ['-C', directory, 'merge', '-q', '--no-edit', 'main'], { stdio: 'ignore' })
  return git(directory, 'rev-parse', 'HEAD')
}

describe('readHeadAdvance', () => {
  it('reads a clean merge of the base branch, with the paths it brought in', async () => {
    const { directory, reviewed } = repositoryWithReviewedHead()
    const baseSha = commitFile(directory, 'main-only.txt', 'main\n', 'main moves')
    const headSha = mergeMain(directory)

    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, headSha, baseSha }, AbortSignal.timeout(10_000))

    expect(advance).toEqual({ _tag: 'Ok', value: { _tag: 'CleanBaseMerges', changedPaths: ['main-only.txt'] } })
  })

  it('reads a merge whose conflict a person resolved', async () => {
    const { directory } = repositoryWithReviewedHead()
    git(directory, 'switch', '-q', 'feature')
    const reviewed = commitFile(directory, 'shared.txt', 'feature\n', 'feature edits shared')
    git(directory, 'switch', '-q', 'main')
    const baseSha = commitFile(directory, 'shared.txt', 'main\n', 'main edits shared')
    git(directory, 'switch', '-q', 'feature')
    expect(() => execFileSync('git', ['-C', directory, 'merge', '-q', '--no-edit', 'main'], { stdio: 'ignore' })).toThrow()
    writeFileSync(join(directory, 'shared.txt'), 'feature and main\n')
    git(directory, 'add', 'shared.txt')
    git(directory, 'commit', '-q', '--no-edit')
    const headSha = git(directory, 'rev-parse', 'HEAD')

    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, headSha, baseSha }, AbortSignal.timeout(10_000))

    expect(advance).toEqual({ _tag: 'Ok', value: { _tag: 'ResolvedBaseMerges', merges: [headSha], changedPaths: ['shared.txt'] } })
  })

  it('reads a merge that edits a file Git merged cleanly as resolved', async () => {
    const { directory, reviewed } = repositoryWithReviewedHead()
    const baseSha = commitFile(directory, 'main-only.txt', 'main\n', 'main moves')
    git(directory, 'switch', '-q', 'feature')
    git(directory, 'merge', '-q', '--no-commit', 'main')
    writeFileSync(join(directory, 'feature.txt'), 'changed inside the merge\n')
    git(directory, 'add', 'feature.txt')
    git(directory, 'commit', '-q', '--no-edit')
    const headSha = git(directory, 'rev-parse', 'HEAD')

    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, headSha, baseSha }, AbortSignal.timeout(10_000))

    expect(advance).toMatchObject({ _tag: 'Ok', value: { _tag: 'ResolvedBaseMerges', merges: [headSha] } })
  })

  it('reads a kept file from a modify/delete conflict as resolved', async () => {
    const { directory } = repositoryWithReviewedHead()
    git(directory, 'switch', '-q', 'feature')
    const reviewed = commitFile(directory, 'shared.txt', 'feature\n', 'feature edits shared')
    git(directory, 'switch', '-q', 'main')
    git(directory, 'rm', '-q', 'shared.txt')
    git(directory, 'commit', '-q', '-m', 'main deletes shared')
    const baseSha = git(directory, 'rev-parse', 'HEAD')
    git(directory, 'switch', '-q', 'feature')
    expect(() => execFileSync('git', ['-C', directory, 'merge', '-q', '--no-edit', 'main'], { stdio: 'ignore' })).toThrow()
    git(directory, 'add', 'shared.txt')
    git(directory, 'commit', '-q', '--no-edit')
    const headSha = git(directory, 'rev-parse', 'HEAD')

    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, headSha, baseSha }, AbortSignal.timeout(10_000))

    expect(advance).toMatchObject({ _tag: 'Ok', value: { _tag: 'ResolvedBaseMerges', merges: [headSha] } })
  })

  it('reads a pull request edit the base merge moved to a renamed file as a changed diff', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'harlan-review-reuse-'))
    temporaryDirectories.push(directory)
    execFileSync('git', ['init', '-q', '-b', 'main', directory])
    git(directory, 'config', 'user.email', 'agent@example.com')
    git(directory, 'config', 'user.name', 'Agent Test')
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`)
    commitFile(directory, 'parser.ts', `${lines.join('\n')}\n`, 'base')
    git(directory, 'switch', '-q', '-c', 'feature')
    const reviewed = commitFile(directory, 'parser.ts', `${lines.map((line, index) => index === 5 ? 'line 6 changed' : line).join('\n')}\n`, 'feature edits parser')
    git(directory, 'switch', '-q', 'main')
    git(directory, 'mv', 'parser.ts', 'legacy-parser.ts')
    git(directory, 'commit', '-q', '-m', 'main renames parser')
    const baseSha = git(directory, 'rev-parse', 'HEAD')
    const headSha = mergeMain(directory)

    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, headSha, baseSha }, AbortSignal.timeout(10_000))

    expect(advance).toEqual({ _tag: 'Ok', value: { _tag: 'ChangedDiff' } })
  })

  it('reads a commit after the merge as new work', async () => {
    const { directory, reviewed } = repositoryWithReviewedHead()
    const baseSha = commitFile(directory, 'main-only.txt', 'main\n', 'main moves')
    mergeMain(directory)
    const headSha = commitFile(directory, 'feature.txt', 'more feature\n', 'more feature')

    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, headSha, baseSha }, AbortSignal.timeout(10_000))

    expect(advance).toEqual({ _tag: 'Ok', value: { _tag: 'NewCommits' } })
  })

  it('reads a rebased branch as rewritten', async () => {
    const { directory, reviewed } = repositoryWithReviewedHead()
    const baseSha = commitFile(directory, 'main-only.txt', 'main\n', 'main moves')
    git(directory, 'switch', '-q', 'feature')
    git(directory, 'rebase', '-q', 'main')
    const headSha = git(directory, 'rev-parse', 'HEAD')

    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, headSha, baseSha }, AbortSignal.timeout(10_000))

    expect(advance).toEqual({ _tag: 'Ok', value: { _tag: 'Rewritten' } })
  })
})

function passed(): ReviewGates {
  return {
    merge: { _tag: 'Passed', evidence: [] },
    review: { _tag: 'Passed', evidence: [] },
    ci: { _tag: 'Passed', evidence: [] },
  }
}

function logged(path: string): ReviewFinding {
  return { _tag: 'Logged', impact: 40, summary: 'A minor note.', details: { fingerprint: `f-${path}`, identity: path, location: { path, line: 3 }, proof: 'Read it.' } }
}

function earlierRun(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    gatePublication: { _tag: 'Unpublished' },
    baseRef: 'main',
    id: 'earlier-run',
    repository: 'harlan-zw/example',
    pullRequestNumber: 24,
    revisionId: 'revision-1',
    headSha: 'abc1234def',
    provider: 'codex',
    sessionId: 'session-1',
    model: 'gpt-6.2-sol',
    agentVersion: '0.0.0',
    skillDigest: 'f'.repeat(64),
    startedAt: '2026-11-24T00:00:00.000Z',
    completedAt: '2026-11-24T00:05:00.000Z',
    usage: { _tag: 'Unavailable' },
    gates: passed(),
    outcome: { _tag: 'Ready', confidence: 92 },
    findings: [],
    feedback: null,
    publications: [],
    ...overrides,
  }
}

const clean: HeadAdvance = { _tag: 'CleanBaseMerges', changedPaths: ['main-only.txt'] }

describe('decideReviewReuse', () => {
  it('carries a passed Review across a clean base merge', () => {
    const earlier = earlierRun({ findings: [logged('src/untouched.ts')] })

    expect(decideReviewReuse({ forced: false, earlier, advance: clean })).toEqual({ _tag: 'Reuse', run: earlier })
  })

  it.each<[string, Parameters<typeof decideReviewReuse>[0]]>([
    ['a requested rerun', { forced: true, earlier: earlierRun(), advance: clean }],
    ['no earlier Review', { forced: false, earlier: undefined, advance: clean }],
    ['a failed review gate', { forced: false, earlier: earlierRun({ gates: { ...passed(), review: { _tag: 'Failed', reason: 'A bug.', evidence: [] } } }), advance: clean }],
    ['an Open finding', { forced: false, earlier: earlierRun({ findings: [{ _tag: 'Open', summary: 'A bug.', nextAction: 'Fix it.' }] }), advance: clean }],
    ['an unreadable head', { forced: false, earlier: earlierRun(), advance: null }],
    ['a rewritten branch', { forced: false, earlier: earlierRun(), advance: { _tag: 'Rewritten' } }],
    ['new commits', { forced: false, earlier: earlierRun(), advance: { _tag: 'NewCommits' } }],
    ['a clean merge that moved the pull request edits', { forced: false, earlier: earlierRun(), advance: { _tag: 'ChangedDiff' } }],
    ['a resolved conflict', { forced: false, earlier: earlierRun(), advance: { _tag: 'ResolvedBaseMerges', merges: ['m'], changedPaths: [] } }],
    ['a merge into a finding\'s file', { forced: false, earlier: earlierRun({ findings: [logged('main-only.txt')] }), advance: clean }],
  ])('reviews again after %s', (_case, input) => {
    expect(decideReviewReuse(input)._tag).toBe('Review')
  })
})

describe('carriedCoverage', () => {
  it('names the reviewed head and why the Review carried', () => {
    expect(carriedCoverage({ headSha: 'abc1234def', checked: 'the parser tests.' }, 'main'))
      .toBe('the parser tests at abc1234; the new commits only merge main without conflicts')
  })

  it('still explains a carried Review that recorded no coverage', () => {
    expect(carriedCoverage({ headSha: 'abc1234def', checked: null }, null))
      .toBe('the Review of abc1234, carried forward because the new commits only merge the base branch without conflicts')
  })
})

const passingCheck = { id: 1, failure: { _tag: 'NotAsked' as const }, source: { _tag: 'CheckRun' as const, appId: 15368 }, name: 'test', status: 'completed', conclusion: 'success' }

/**
 * Runs one Review whose pull request has an earlier reviewed head, and reports
 * how many Agent turns started and what the Review run recorded.
 */
async function reviewAfterEarlierHead(earlier: ReviewRun, advance: HeadAdvance, rerun: ClaimedAdversarialReviewTask['rerun'] = { _tag: 'NotRequested' }) {
  const pullRequest = pullRequestItem({ mergeState: 'clean' })
  const capture: ProviderCapture = { requests: [] }
  const recorded: RecordReviewRunInput[] = []
  const worker = createReviewWorker({
    runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
      checked: 'the changed files',
      notChecked: null,
      premise: { verdict: 'sound', reason: 'The change keeps its intent.' },
      findings: [],
      confidence: 96,
    }), capture)),
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
      getRepairedHeadFindings: () => [],
      repairRoundPlan: () => ({ _tag: 'Allowed' as const, number: 1 }),
      getWorkerSession: () => null,
      storedReviewForHead: () => ({ _tag: 'None' }),
      getRevisionFiles: () => ({ files: [{ path: 'src/parser.ts', status: 'modified', additions: 4, deletions: 2, previousFilename: null }], headSha: 'abc123' }),
      supersedeReviewRun: input => ({ _tag: 'Inserted', reviewRunId: input.id }),
      recordIncident: () => { throw new Error('Unexpected Incident.') },
      queueBaselineRepairForReview: () => { throw new Error('Healthy base CI must not queue Baseline repair.') },
      retireBaselineRepairForReview: () => 0,
      saveWorkerSession: () => undefined,
      ...agentTurnLedger,
      updateAgentProgress: () => true,
      priorReviewHistory: () => ({ _tag: 'FirstReview' as const }),
      latestReviewOfEarlierHead: () => earlier,
      repairSource: () => null,
      recordReviewRun: (input) => {
        recorded.push(input)
        return { _tag: 'Inserted', reviewRunId: input.id }
      },
      recordReviewPublication: input => ({ _tag: 'Inserted', publicationId: input.id }),
    },
    status: {
      publish: () => Promise.resolve(ok({ commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })),
    },
    triageStatus: { publish: () => Promise.reject(new Error('Review must not publish issue triage.')) },
    workspaces: {
      prepareIssue: () => Promise.reject(new Error('Unexpected issue workspace.')),
      prepareReview: () => Promise.resolve(ok({ path: '/tmp/review-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
      verifyReview: () => Promise.resolve(ok(undefined)),
      readHeadAdvance: (_worktree, earlierHeadSha) => earlierHeadSha === earlier.headSha
        ? Promise.resolve(ok(advance))
        : Promise.reject(new Error('The probe must compare the earlier reviewed head.')),
    },
  })

  const result = await worker.run({
    id: 'review-task',
    kind: 'adversarial_review',
    repository: 'harlan-zw/example',
    pullRequestNumber: 24,
    revisionId: 'revision-2',
    state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-11-24T02:00:00.000Z' },
    updatedAt: '2026-11-24T01:00:00.000Z',
    repositoryMapping: repositoryMapping(),
    pullRequest,
    rerun,
  }, new AbortController().signal)

  if (result._tag !== 'Ok')
    throw new Error(result.error)
  return { turns: capture.requests.length, run: recorded.at(0) }
}

describe('a Review after an earlier reviewed head', () => {
  it('carries the earlier verdict across a clean base merge without an Agent turn', async () => {
    const earlier = earlierRun({ findings: [logged('src/untouched.ts')] })

    const review = await reviewAfterEarlierHead(earlier, clean)

    expect(review.turns).toBe(0)
    expect(review.run).toMatchObject({
      headSha: pullRequestItem().headSha,
      model: earlier.model,
      usage: { _tag: 'Available', input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      gates: { review: { _tag: 'Passed' } },
      confidence: 92,
      checked: 'the Review of abc1234, carried forward because the new commits only merge main without conflicts',
    })
    expect(review.run?.findings).toMatchObject([{ _tag: 'Logged', details: { location: { path: 'src/untouched.ts' } } }])
  })

  it('carries the earlier verdict for the automatic Review of a new head', async () => {
    // Every later head of a reviewed pull request claims as a NewRevision, so
    // reading it as a requested rerun kept the carry from ever running.
    const review = await reviewAfterEarlierHead(earlierRun(), clean, { _tag: 'NewRevision' })

    expect(review.turns).toBe(0)
  })

  it('runs a fresh Agent turn when a rerun was requested', async () => {
    const review = await reviewAfterEarlierHead(earlierRun(), clean, { _tag: 'Requested' })

    expect(review.turns).toBe(1)
  })

  it('runs a fresh Agent turn when the new head adds its own commit', async () => {
    const review = await reviewAfterEarlierHead(earlierRun(), { _tag: 'NewCommits' })

    expect(review.turns).toBe(1)
    expect(review.run).toMatchObject({ checked: 'the changed files', confidence: 96 })
  })
})

describe('latestReviewOfEarlierHead', () => {
  it('finds the Review of the previous head once a new head arrives', () => {
    const store = openJournalStore(':memory:')
    try {
      const repository = repositoryMapping()
      store.syncRepositories([repository], '2026-11-24T00:00:00.000Z')
      store.setRepositoryWritesEnabled(repository.github, true)
      store.recordObservation({ externalId: 'first-head', observedAt: '2026-11-24T00:01:00.000Z', source: 'poll', subject: pullRequestItem({ mergeState: 'clean', headSha: 'abc123' }) })
      const task = store.claimNextAdversarialReviewTask('reviewer', '2026-11-24T00:01:30.000Z', 60 * 60_000)!
      expect(store.recordReviewRun({ ...earlierRun({ id: 'first-review', headSha: 'abc123', revisionId: task.revisionId }), confidence: 92 })._tag).toBe('Inserted')

      expect(store.latestReviewOfEarlierHead(repository.github, 24, 'abc123')).toBeUndefined()

      store.recordObservation({ externalId: 'merged-main', observedAt: '2026-11-24T00:10:00.000Z', source: 'poll', subject: pullRequestItem({ mergeState: 'clean', headSha: 'def456', baseSha: 'base456' }) })

      expect(store.latestReviewOfEarlierHead(repository.github, 24, 'def456')).toMatchObject({ id: 'first-review', headSha: 'abc123' })
    }
    finally {
      store.close()
    }
  })
})
