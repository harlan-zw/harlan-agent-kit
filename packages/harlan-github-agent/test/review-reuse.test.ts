import type { PullRequestReviewSnapshot } from '../src/github-agent-source.ts'
import type { GitHubMediaSource } from '../src/github-media.ts'
import type { HeadAdvance } from '../src/review-reuse.ts'
import type { ClaimedAdversarialReviewTask, RecordReviewRunInput, ReviewFinding, ReviewGates, ReviewRun } from '../src/types.ts'
import type { ProviderCapture } from './fixtures.ts'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
  it('starts a fresh Review when a clean base merge repurposes a reviewed permission', async () => {
    const { directory } = repositoryWithReviewedHead()
    const permissions = (name: string, allowed: boolean) => [
      `export function ${name}() {`,
      ...Array.from({ length: 12 }, (_, index) => `  // Permission context ${index + 1}.`),
      `  return ${allowed}`,
      '}',
      '',
    ].join('\n')
    const earlierBaseSha = commitFile(directory, 'permissions.ts', permissions('canRead', false), 'read permission')
    git(directory, 'switch', '-q', 'feature')
    git(directory, 'merge', '-q', '--no-edit', 'main')
    const reviewed = commitFile(directory, 'permissions.ts', permissions('canRead', true), 'permit reading')
    git(directory, 'switch', '-q', 'main')
    const baseSha = commitFile(directory, 'permissions.ts', permissions('canDelete', false), 'repurpose permission for deletion')
    const headSha = mergeMain(directory)

    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, earlierBaseSha, headSha, baseSha }, AbortSignal.timeout(10_000))

    if (advance._tag !== 'Ok')
      throw new Error(advance.error)
    const review = await reviewAfterEarlierHead(earlierRun({ headSha: reviewed, baseSha: earlierBaseSha }), advance.value)
    expect(review.turns).toBe(1)
  })

  it('starts a fresh Review when a rewritten base moves the same edit between functions', async () => {
    const { directory } = repositoryWithReviewedHead()
    const permissions = (read: boolean, remove: boolean) => [
      'export function canRead() {',
      `  return ${read}`,
      '}',
      '',
      '// Deletion requires a separate permission.',
      '',
      'export function canDelete() {',
      `  return ${remove}`,
      '}',
      '',
    ].join('\n')
    const common = commitFile(directory, 'permissions.ts', permissions(false, false), 'shared permissions')
    const earlierBaseSha = commitFile(directory, 'permissions.ts', permissions(false, true), 'base permits deletion')
    git(directory, 'switch', '-q', 'feature')
    git(directory, 'reset', '--hard', earlierBaseSha)
    const reviewed = commitFile(directory, 'permissions.ts', permissions(true, true), 'permit reading')
    git(directory, 'switch', '-q', 'main')
    git(directory, 'reset', '--hard', common)
    const baseSha = commitFile(directory, 'permissions.ts', permissions(true, false), 'rewritten base permits reading')
    const headSha = mergeMain(directory)

    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, earlierBaseSha, headSha, baseSha }, AbortSignal.timeout(10_000))

    if (advance._tag !== 'Ok')
      throw new Error(advance.error)
    const review = await reviewAfterEarlierHead(earlierRun({ headSha: reviewed, baseSha: earlierBaseSha }), advance.value)
    expect(review.turns).toBe(1)
  })

  it('requires a fresh Review when a rewritten base exposes a previously shared commit', async () => {
    const { directory } = repositoryWithReviewedHead()
    const originalBaseSha = commitFile(directory, 'shared-change.txt', 'outside the reviewed diff\n', 'shared change')
    const reviewed = mergeMain(directory)
    git(directory, 'switch', '-q', 'main')
    git(directory, 'reset', '--hard', `${originalBaseSha}^`)
    const baseSha = commitFile(directory, 'replacement.txt', 'rewritten base\n', 'replacement base')
    const headSha = mergeMain(directory)

    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, earlierBaseSha: originalBaseSha, headSha, baseSha }, AbortSignal.timeout(10_000))

    expect(advance).toEqual({ _tag: 'Ok', value: { _tag: 'ChangedDiff' } })
    if (advance._tag !== 'Ok')
      throw new Error(advance.error)
    const review = await reviewAfterEarlierHead(earlierRun({ headSha: reviewed, baseSha: originalBaseSha }), advance.value)
    expect(review.turns).toBe(1)
  })

  it('reads a clean merge of the base branch, with the paths it brought in', async () => {
    const { directory, reviewed } = repositoryWithReviewedHead()
    const baseSha = commitFile(directory, 'main-only.txt', 'main\n', 'main moves')
    const headSha = mergeMain(directory)

    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, earlierBaseSha: git(directory, 'merge-base', reviewed, baseSha), headSha, baseSha }, AbortSignal.timeout(10_000))

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

    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, earlierBaseSha: git(directory, 'merge-base', reviewed, baseSha), headSha, baseSha }, AbortSignal.timeout(10_000))

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

    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, earlierBaseSha: git(directory, 'merge-base', reviewed, baseSha), headSha, baseSha }, AbortSignal.timeout(10_000))

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

    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, earlierBaseSha: git(directory, 'merge-base', reviewed, baseSha), headSha, baseSha }, AbortSignal.timeout(10_000))

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

    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, earlierBaseSha: git(directory, 'merge-base', reviewed, baseSha), headSha, baseSha }, AbortSignal.timeout(10_000))

    expect(advance).toEqual({ _tag: 'Ok', value: { _tag: 'ChangedDiff' } })
  })

  it('reads a commit after the merge as new work', async () => {
    const { directory, reviewed } = repositoryWithReviewedHead()
    const baseSha = commitFile(directory, 'main-only.txt', 'main\n', 'main moves')
    mergeMain(directory)
    const headSha = commitFile(directory, 'feature.txt', 'more feature\n', 'more feature')

    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, earlierBaseSha: git(directory, 'merge-base', reviewed, baseSha), headSha, baseSha }, AbortSignal.timeout(10_000))

    expect(advance).toEqual({ _tag: 'Ok', value: { _tag: 'NewCommits' } })
  })

  it('reads a rebased branch as rewritten', async () => {
    const { directory, reviewed } = repositoryWithReviewedHead()
    const baseSha = commitFile(directory, 'main-only.txt', 'main\n', 'main moves')
    git(directory, 'switch', '-q', 'feature')
    git(directory, 'rebase', '-q', 'main')
    const headSha = git(directory, 'rev-parse', 'HEAD')

    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, earlierBaseSha: git(directory, 'merge-base', reviewed, baseSha), headSha, baseSha }, AbortSignal.timeout(10_000))

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
    baseSha: 'original-base',
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
async function reviewAfterEarlierHead(
  earlier: ReviewRun,
  advance: HeadAdvance,
  rerun: ClaimedAdversarialReviewTask['rerun'] = { _tag: 'NotRequested' },
  evidence: { snapshot?: Partial<PullRequestReviewSnapshot>, source?: GitHubMediaSource } = {},
) {
  const pullRequest = pullRequestItem({ mergeState: 'clean' })
  const capture: ProviderCapture = { requests: [] }
  const recorded: RecordReviewRunInput[] = []
  const worker = createReviewWorker({
    ...(evidence.source === undefined ? {} : { mediaSource: evidence.source }),
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
        ...evidence.snapshot,
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
      mergedWithFailingChecks: () => null,
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
      readHeadAdvance: (_worktree, compared) => compared.headSha === earlier.headSha && compared.baseSha === earlier.baseSha
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
  return { turns: capture.requests.length, run: recorded.at(0), requests: capture.requests }
}

describe('a Review after an earlier reviewed head', () => {
  const image = { mime: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAABQAAAAKCAYAAAC0VX7mAAAAF0lEQVR4nGNkoDIYNZByMGog5YDqBgIAFJEAC2Vie2MAAAAASUVORK5CYII=', label: 'Current: clipped UI', source: 'https://github.com/user-attachments/assets/current' }
  const reference = { url: image.source, label: image.label }
  it.each<Partial<PullRequestReviewSnapshot>>([
    { body: `![${image.label}](${image.source})` },
    { authorComments: [`![${image.label}](${image.source})`] },
    { imageReferences: [reference] },
  ])('retrieves current screenshot evidence and starts a fresh Review: %j', async (snapshot) => {
    const retrieved: unknown[] = []
    const review = await reviewAfterEarlierHead(earlierRun(), clean, { _tag: 'NewRevision' }, {
      snapshot,
      source: async (_repository, references) => {
        retrieved.push(...references)
        return { images: [image], unavailable: [] }
      },
    })

    expect(review.turns).toBe(1)
    expect(retrieved).toEqual([reference])
    expect(review.requests[0]?.media).toEqual([image])
  })

  it('starts a fresh Review with retrieval failure evidence for an inaccessible screenshot', async () => {
    const review = await reviewAfterEarlierHead(earlierRun(), clean, { _tag: 'NewRevision' }, {
      snapshot: { imageReferences: [reference] },
      source: async () => ({ images: [], unavailable: [{ label: image.label, reason: 'Image retrieval returned HTTP 404.' }] }),
    })

    expect(review.turns).toBe(1)
    expect(review.requests[0]?.prompt).toContain('Image retrieval returned HTTP 404.')
    expect(review.requests[0]?.prompt).toContain('Return a material documentation finding for unavailable evidence.')
  })

  it('runs a fresh Agent turn when the earlier Review has no recorded base', async () => {
    const review = await reviewAfterEarlierHead(earlierRun({ baseSha: null }), clean)

    expect(review.turns).toBe(1)
  })

  it('carries the earlier verdict across a clean base merge without an Agent turn', async () => {
    const earlier = earlierRun({ findings: [logged('src/untouched.ts')] })

    const review = await reviewAfterEarlierHead(earlier, clean)

    expect(review.turns).toBe(0)
    expect(review.run).toMatchObject({
      baseSha: pullRequestItem().baseSha,
      headSha: pullRequestItem().headSha,
      model: earlier.model,
      usage: { _tag: 'Available', input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      gates: { review: { _tag: 'Passed' } },
      confidence: 92,
      checked: 'the Review of abc1234, carried forward because the new commits only merge main without conflicts',
    })
    expect(review.run?.findings).toMatchObject([{ _tag: 'Logged', details: { location: { path: 'src/untouched.ts' } } }])
  })

  it('runs a fresh Agent turn when the new head adds its own commit', async () => {
    const review = await reviewAfterEarlierHead(earlierRun(), { _tag: 'NewCommits' })

    expect(review.turns).toBe(1)
    expect(review.run).toMatchObject({ checked: 'the changed files', confidence: 96 })
  })
})

/** The rerun value the store's own claim gives the Review of a second head. */
function claimedRerunOfSecondHead(): ClaimedAdversarialReviewTask['rerun'] {
  const store = openJournalStore(':memory:')
  try {
    const repository = repositoryMapping()
    store.syncRepositories([repository], '2026-11-24T00:00:00.000Z')
    store.setRepositoryWritesEnabled(repository.github, true)
    store.recordObservation({ externalId: 'first-head', observedAt: '2026-11-24T00:01:00.000Z', source: 'poll', subject: pullRequestItem({ mergeState: 'clean', headSha: 'abc123' }) })
    const first = store.claimNextAdversarialReviewTask('reviewer', '2026-11-24T00:01:30.000Z', 60 * 60_000)!
    store.recordReviewRun({ ...earlierRun({ id: 'first-review', headSha: 'abc123', revisionId: first.revisionId }), confidence: 92 })
    store.recordObservation({ externalId: 'merged-main', observedAt: '2026-11-24T00:10:00.000Z', source: 'poll', subject: pullRequestItem({ mergeState: 'clean', headSha: 'def456', baseSha: 'base456' }) })
    return store.claimNextAdversarialReviewTask('reviewer', '2026-11-24T00:10:30.000Z', 60 * 60_000)!.rerun
  }
  finally {
    store.close()
  }
}

describe('a Review the store claims for a new head', () => {
  it('carries the earlier verdict across a clean base merge', async () => {
    const review = await reviewAfterEarlierHead(earlierRun(), clean, claimedRerunOfSecondHead())

    expect(review.turns).toBe(0)
  })

  it('runs a fresh Agent turn when a person asked for a rerun', async () => {
    const review = await reviewAfterEarlierHead(earlierRun(), clean, { _tag: 'Requested' })

    expect(review.turns).toBe(1)
  })
})

describe('latestReviewOfEarlierHead', () => {
  it('keeps legacy Reviews without a base when upgrading the Journal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'harlan-review-reuse-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'journal.sqlite')
    const before = openJournalStore(path)
    const repository = repositoryMapping()
    before.syncRepositories([repository], '2026-11-24T00:00:00.000Z')
    before.setRepositoryWritesEnabled(repository.github, true)
    before.recordObservation({ externalId: 'legacy-head', observedAt: '2026-11-24T00:01:00.000Z', source: 'poll', subject: pullRequestItem({ mergeState: 'clean' }) })
    const task = before.claimNextAdversarialReviewTask('reviewer', '2026-11-24T00:01:30.000Z', 60 * 60_000)!
    expect(before.recordReviewRun({ ...earlierRun({ headSha: task.pullRequest.headSha, revisionId: task.revisionId }), confidence: 92 })._tag).toBe('Inserted')
    before.close()
    const legacy = new DatabaseSync(path)
    legacy.exec('ALTER TABLE review_runs DROP COLUMN base_sha; PRAGMA user_version = 112;')
    legacy.close()

    const migrated = openJournalStore(path)
    try {
      expect(migrated.listReviewRuns(repository.github, 24)).toMatchObject([{ headSha: task.pullRequest.headSha, baseSha: null }])
    }
    finally {
      migrated.close()
    }
  })

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

      expect(store.supersedeReviewRun({
        ...earlierRun({ id: 'gate-refresh', headSha: 'abc123', revisionId: task.revisionId, baseSha: 'unreviewed-base' }),
        supersedesReviewRunId: 'first-review',
        confidence: 92,
        publication: {
          id: 'gate-publication',
          body: 'READY',
          at: '2026-11-24T00:06:00.000Z',
          result: { _tag: 'Published', githubCommentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' },
        },
      })._tag).toBe('Inserted')

      store.recordObservation({ externalId: 'merged-main', observedAt: '2026-11-24T00:10:00.000Z', source: 'poll', subject: pullRequestItem({ mergeState: 'clean', headSha: 'def456', baseSha: 'base456' }) })

      expect(store.latestReviewOfEarlierHead(repository.github, 24, 'def456')).toMatchObject({ id: 'gate-refresh', headSha: 'abc123', baseSha: 'original-base' })
    }
    finally {
      store.close()
    }
  })
})
