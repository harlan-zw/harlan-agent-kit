import type { ClaimedConflictResolutionTask, ClaimedIssueWorkTask, ClaimedReviewFixTask, ReviewFinding } from '../src/types.ts'
import type { PreparedConflictWorktree } from '../src/worktree.ts'
import { describe, expect, it } from 'vitest'
import { CHECK_SCOPES, checkBudgetLines, TOOLCHAIN_LINES, UNIT_TEST_LINES } from '../src/agent-context.ts'
import { baselineRepairPrompt } from '../src/baseline-repair-worker.ts'
import { batchPlanPrompt } from '../src/batch-worker.ts'
import { conflictResolutionPrompt } from '../src/conflict-worker.ts'
import { issueWorkPrompt } from '../src/issue-work-worker.ts'
import { reviewFixPrompt } from '../src/review-fix-worker.ts'
import { routineScanPrompt } from '../src/routine-worker.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

function issueWorkTask(): ClaimedIssueWorkTask {
  const mapping = repositoryMapping()
  const issue = issueItem()
  return {
    id: 'issue-work-task',
    kind: 'issue_work',
    repository: mapping.github,
    issueNumber: issue.number,
    revisionId: 'revision-1',
    state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T01:10:00.000Z' },
    updatedAt: '2026-08-13T01:00:00.000Z',
    repositoryMapping: mapping,
    issue,
  }
}

function reviewFixTask(): ClaimedReviewFixTask {
  const mapping = repositoryMapping({ ownership: 'maintained' })
  const pullRequest = pullRequestItem({ mergeState: 'clean' })
  return {
    id: 'repair-task',
    kind: 'review_fix',
    repository: mapping.github,
    pullRequestNumber: pullRequest.number,
    revisionId: 'revision-1',
    state: { _tag: 'Running', workerId: 'repair-worker', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
    updatedAt: '2026-08-13T01:00:00.000Z',
    repositoryMapping: mapping,
    pullRequest,
    rounds: { number: 1, limit: 3, prior: [] },
  }
}

function conflictTask(): ClaimedConflictResolutionTask {
  const mapping = repositoryMapping()
  const pullRequest = pullRequestItem({ baseSha: 'previous-base' })
  return {
    id: 'conflict-task',
    kind: 'resolve_conflict',
    repository: mapping.github,
    pullRequestNumber: pullRequest.number,
    revisionId: 'revision-1',
    state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T01:10:00.000Z' },
    updatedAt: '2026-08-13T01:00:00.000Z',
    repositoryMapping: mapping,
    pullRequest,
  }
}

const conflictWorktree: PreparedConflictWorktree = {
  path: '/tmp/conflict-worktree',
  headSha: 'head-sha',
  baseSha: 'current-base',
  conflictedFiles: ['src/a.ts'],
}

const findings: ReviewFinding[] = [{
  _tag: 'Open',
  summary: 'The parser drops buffered bytes.',
  nextAction: 'Preserve all buffered bytes.',
}]

/**
 * Every prompt an Agent turn receives, with the fragments its contract earns.
 *
 * A worker that may run a command gets the toolchain rule, or it can reach for
 * npm. A worker that verifies its own change gets a check budget, or it can run
 * the whole suite CI already runs. Only a worker that may write a test gets the
 * unit test rules, because the rules are noise to a turn that writes none.
 */
const prompts = {
  issueWork: {
    build: () => issueWorkPrompt({
      task: issueWorkTask(),
      body: 'Body',
      comments: [],
      template: { _tag: 'Missing' },
      routineSource: null,
      triage: null,
      instructionFiles: [],
    }),
    checkBudget: CHECK_SCOPES.changedFiles,
    writesTests: true,
  },
  reviewFix: {
    build: () => reviewFixPrompt({ task: reviewFixTask(), findings, instructionFiles: [] }),
    checkBudget: CHECK_SCOPES.changedFiles,
    writesTests: true,
  },
  baselineRepair: {
    build: () => baselineRepairPrompt({
      repository: 'harlan-zw/example',
      baseSha: 'base-sha',
      repairable: [{
        _tag: 'Available',
        check: { id: 1, failure: { _tag: 'NotAsked' }, source: { _tag: 'CheckRun', appId: 15368 }, name: 'test', status: 'completed', conclusion: 'failure' },
        job: { runId: 1, jobName: 'test', failedStep: 'Run pnpm test', logTail: ['FAIL test/parser.test.ts'] },
      }],
      infrastructure: [],
      workspace: { hasAgentsFile: false, nodeOptions: null },
    }),
    checkBudget: CHECK_SCOPES.failingCheck,
    writesTests: true,
  },
  conflict: {
    build: () => conflictResolutionPrompt(conflictTask(), conflictWorktree),
    checkBudget: CHECK_SCOPES.conflictedFiles,
    writesTests: false,
  },
  routineScan: {
    build: () => routineScanPrompt({ mode: 'propose', name: 'pr-triage', rejected: [], repository: 'harlan-zw/example' }),
    checkBudget: null,
    writesTests: false,
  },
  batchPlan: {
    build: () => batchPlanPrompt({
      repository: 'harlan-zw/example',
      issues: [{ taskId: 't1', issueNumber: 101, title: 'A', body: 'Body A', triageSummary: 'Summary A', relatedIssues: [], target: 'src/a.ts' }],
    }),
    checkBudget: null,
    writesTests: false,
  },
} as const

describe('agent prompt fragments', () => {
  for (const [name, worker] of Object.entries(prompts)) {
    it(`gives the ${name} turn the pnpm toolchain rule`, () => {
      expect(worker.build()).toContain(TOOLCHAIN_LINES)
    })

    it(`gives the ${name} turn ${worker.checkBudget === null ? 'no check budget' : 'its own check budget'}`, () => {
      const prompt = worker.build()
      if (worker.checkBudget === null)
        expect(prompt).not.toContain('Check budget:')
      else
        expect(prompt).toContain(checkBudgetLines(worker.checkBudget))
    })

    it(`${worker.writesTests ? 'gives' : 'withholds'} the unit test rules for the ${name} turn`, () => {
      const prompt = worker.build()
      if (worker.writesTests)
        expect(prompt).toContain(UNIT_TEST_LINES)
      else
        expect(prompt).not.toContain(UNIT_TEST_LINES)
    })
  }

  it('gives each check budget the scope its own work defines', () => {
    expect(conflictResolutionPrompt(conflictTask(), conflictWorktree)).not.toContain(CHECK_SCOPES.changedFiles)
    expect(reviewFixPrompt({ task: reviewFixTask(), findings, instructionFiles: [] })).not.toContain(CHECK_SCOPES.failingCheck)
  })

  it('never tells a turn to run the full suite CI already runs', () => {
    for (const worker of Object.values(prompts)) {
      if (worker.checkBudget !== null)
        expect(worker.build()).toContain('Do not run the full test suite, the full typecheck, or a build. CI runs those.')
    }
  })

  it('resolves the full-suite contradiction for the baseline repair turn', () => {
    const prompt = prompts.baselineRepair.build()
    expect(prompt).toContain('failed step "Run pnpm test"')
    expect(prompt).toMatch(/narrower command|prefer the narrower/i)
  })
})
