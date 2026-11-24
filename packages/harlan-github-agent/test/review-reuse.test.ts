import type { HeadAdvance } from '../src/review-reuse.ts'
import type { RecordReviewRunInput, ReviewFinding, ReviewGates, ReviewRun } from '../src/types.ts'
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

    expect(advance).toMatchObject({ _tag: 'Ok', value: { _tag: 'ResolvedBaseMerges', merges: [headSha], changedPaths: ['shared.txt'] } })
    const resolution = advance._tag === 'Ok' && advance.value._tag === 'ResolvedBaseMerges' ? advance.value.resolution : null
    expect(resolution).toContain(`Merge ${headSha}`)
    expect(resolution).toContain('+feature and main')
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
    ['a conflict resolution too large to review alone', { forced: false, earlier: earlierRun(), advance: { _tag: 'ResolvedBaseMerges', merges: ['m'], changedPaths: [], resolution: null } }],
    ['a conflict resolution in a carried finding\'s file', { forced: false, earlier: earlierRun({ findings: [logged('shared.txt')] }), advance: { _tag: 'ResolvedBaseMerges', merges: ['m'], changedPaths: ['shared.txt'], resolution: 'diff' } }],
    ['a merge into a finding\'s file', { forced: false, earlier: earlierRun({ findings: [logged('main-only.txt')] }), advance: clean }],
  ])('reviews again after %s', (_case, input) => {
    expect(decideReviewReuse(input)._tag).toBe('Review')
  })

  it('carries earlier findings with resolution evidence for the full diff Review', () => {
    const earlier = earlierRun()

    expect(decideReviewReuse({ forced: false, earlier, advance: { _tag: 'ResolvedBaseMerges', merges: ['m'], changedPaths: ['shared.txt'], resolution: 'diff' } }))
      .toEqual({ _tag: 'ReviewResolution', run: earlier, resolution: 'diff' })
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
async function reviewAfterEarlierHead(earlier: ReviewRun, advance: HeadAdvance) {
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
    rerun: { _tag: 'NotRequested' },
  }, new AbortController().signal)

  if (result._tag !== 'Ok')
    throw new Error(result.error)
  return { turns: capture.requests.length, prompt: capture.requests.at(0)?.prompt ?? '', run: recorded.at(0) }
}

describe('a Review after an earlier reviewed head', () => {
  it('permits a finding on surviving code when a deletion-only resolution drops a required fallback', async () => {
    const { directory } = repositoryWithReviewedHead()
    const original = 'export function value(input) {\n  return input\n}\n'
    const feature = 'export function value(input) {\n  return input.value\n}\n'
    git(directory, 'switch', '-q', 'feature')
    commitFile(directory, 'value.js', original, 'add value')
    git(directory, 'switch', '-q', 'main')
    git(directory, 'merge', '-q', 'feature')
    git(directory, 'switch', '-q', 'feature')
    const reviewed = commitFile(directory, 'value.js', feature, 'read value')
    git(directory, 'switch', '-q', 'main')
    const baseSha = commitFile(directory, 'value.js', 'export function value(input) {\n  return input ?? "fallback"\n}\n', 'add fallback')
    git(directory, 'switch', '-q', 'feature')
    expect(() => git(directory, 'merge', '-q', '--no-edit', 'main')).toThrow()
    writeFileSync(join(directory, 'value.js'), feature)
    git(directory, 'add', 'value.js')
    git(directory, 'commit', '-q', '--no-edit')
    const headSha = git(directory, 'rev-parse', 'HEAD')
    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, headSha, baseSha }, AbortSignal.timeout(10_000))
    if (advance._tag !== 'Ok' || advance.value._tag !== 'ResolvedBaseMerges')
      throw new Error('Expected a resolved base merge.')
    const resolution = advance.value.resolution!
    expect(resolution).toContain('-  return input ?? "fallback"')
    expect(resolution.split('\n').some(line => line.startsWith('+') && !line.startsWith('+++'))).toBe(false)

    const review = await reviewAfterEarlierHead(earlierRun({ headSha: reviewed }), advance.value)

    expect(review.prompt).not.toContain('Report findings only on lines the resolution wrote.')
    expect(review.prompt).toContain('Report deletion defects on surviving code or the affected file.')
  })

  it('requests the full diff when a clean helper change breaks an extra caller beside an unrelated conflict', async () => {
    const { directory } = repositoryWithReviewedHead()
    commitFile(directory, 'helper.ts', 'export const value = () => "ok"\n', 'add helper')
    commitFile(directory, 'caller.ts', 'import { value } from "./helper.ts"\nexport const call = () => value().toUpperCase()\n', 'add base caller')
    git(directory, 'switch', '-q', 'feature')
    git(directory, 'merge', '-q', 'main')
    commitFile(directory, 'extra.ts', 'import { value } from "./helper.ts"\nexport const extra = () => value().toUpperCase()\n', 'add extra caller')
    const callExtra = () => execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', 'import { extra } from "./extra.ts"; console.log(extra())'], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(callExtra()).toBe('OK\n')
    const reviewed = commitFile(directory, 'shared.txt', 'feature\n', 'feature text')
    git(directory, 'switch', '-q', 'main')
    commitFile(directory, 'helper.ts', 'export const value = () => ({ text: "ok" })\n', 'change helper contract')
    commitFile(directory, 'caller.ts', 'import { value } from "./helper.ts"\nexport const call = () => value().text.toUpperCase()\n', 'update base caller')
    const baseSha = commitFile(directory, 'shared.txt', 'main\n', 'base text')
    git(directory, 'switch', '-q', 'feature')
    expect(() => git(directory, 'merge', '-q', '--no-edit', 'main')).toThrow()
    writeFileSync(join(directory, 'shared.txt'), 'feature and main\n')
    git(directory, 'add', 'shared.txt')
    git(directory, 'commit', '-q', '--no-edit')
    const headSha = git(directory, 'rev-parse', 'HEAD')
    expect(callExtra).toThrow('value(...).toUpperCase is not a function')
    const advance = await readHeadAdvance(directory, { earlierHeadSha: reviewed, headSha, baseSha }, AbortSignal.timeout(10_000))
    if (advance._tag !== 'Ok' || advance.value._tag !== 'ResolvedBaseMerges')
      throw new Error('Expected a resolved base merge.')
    expect(advance.value.resolution).not.toContain('helper.ts')
    expect(advance.value.resolution).not.toContain('extra.ts')

    const review = await reviewAfterEarlierHead(earlierRun({ headSha: reviewed }), advance.value)

    expect(review.turns).toBe(1)
    expect(review.prompt).toContain('Use review_read with revision diff and an empty path. Follow nextOffset until truncated is false.')
    expect(review.prompt).not.toContain('Do not page the whole diff.')
  })

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

  it('supplements the full diff with the resolution and carries the earlier findings', async () => {
    const earlier = earlierRun({ findings: [logged('src/untouched.ts')] })

    const review = await reviewAfterEarlierHead(earlier, { _tag: 'ResolvedBaseMerges', merges: ['m'], changedPaths: ['shared.txt'], resolution: '+feature and main' })

    expect(review.turns).toBe(1)
    expect(review.prompt).toContain('Review the full diff and integration with cleanly merged changes.')
    expect(review.prompt).toContain('+feature and main')
    expect(review.prompt).toContain('Follow nextOffset until truncated is false.')
    expect(review.run).toMatchObject({
      confidence: 92,
      checked: 'the changed files; earlier findings carried from the Review of abc1234',
      gates: { review: { _tag: 'Passed' } },
    })
    expect(review.run?.findings).toMatchObject([{ _tag: 'Logged', details: { location: { path: 'src/untouched.ts' } } }])
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
