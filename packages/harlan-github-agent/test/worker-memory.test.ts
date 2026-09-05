import type { RepositoryMemory } from '../src/agent-context.ts'
import type { PullRequestReviewSnapshot } from '../src/github-agent-source.ts'
import type { ClaimedAdversarialReviewTask, ClaimedConflictResolutionTask, ClaimedIssueTriageTask } from '../src/types.ts'
import type { PreparedConflictWorktree } from '../src/worktree.ts'
import { describe, expect, it } from 'vitest'
import { batchPlanPrompt } from '../src/batch-worker.ts'
import { conflictResolutionPrompt } from '../src/conflict-worker.ts'
import { issuePrompt, reviewPrompt } from '../src/item-agent.ts'
import { pullRequestTriagePrompt } from '../src/pull-request-triage.ts'
import { routineScanPrompt } from '../src/routine-worker.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

const memory: RepositoryMemory = {
  indexPath: '/home/harlan/.claude/projects/-home-harlan-pkg-example/memory/MEMORY.md',
}

function reviewTask(): ClaimedAdversarialReviewTask {
  const mapping = repositoryMapping()
  const pullRequest = pullRequestItem({ mergeState: 'clean' })
  return {
    id: 'review-task',
    kind: 'adversarial_review',
    repository: mapping.github,
    pullRequestNumber: pullRequest.number,
    revisionId: 'revision-1',
    state: { _tag: 'Running', workerId: 'review-worker', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
    updatedAt: '2026-08-13T01:00:00.000Z',
    repositoryMapping: mapping,
    pullRequest,
    rerun: { _tag: 'NotRequested' },
  }
}

function reviewSnapshot(): PullRequestReviewSnapshot {
  return {
    baseChecks: { _tag: 'Available', checks: [] },
    body: 'Fixes the bug.',
    checks: { _tag: 'Available', checks: [] },
    comments: [],
    priorAutomatedReview: { _tag: 'None' },
    pullRequest: pullRequestItem({ mergeState: 'clean' }),
    requiredChecks: { _tag: 'None' },
    reviews: [],
  }
}

function issueTriageTask(): ClaimedIssueTriageTask {
  const mapping = repositoryMapping()
  const issue = issueItem()
  return {
    id: 'issue-triage-task',
    kind: 'issue_triage',
    repository: mapping.github,
    issueNumber: issue.number,
    revisionId: 'revision-1',
    state: { _tag: 'Running', workerId: 'triage-worker', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
    updatedAt: '2026-08-13T01:00:00.000Z',
    repositoryMapping: mapping,
    issue,
  }
}

function conflictTask(): ClaimedConflictResolutionTask {
  const mapping = repositoryMapping()
  return {
    id: 'conflict-task',
    kind: 'resolve_conflict',
    repository: mapping.github,
    pullRequestNumber: 24,
    revisionId: 'revision-1',
    state: { _tag: 'Running', workerId: 'conflict-worker', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
    updatedAt: '2026-08-13T01:00:00.000Z',
    repositoryMapping: mapping,
    pullRequest: pullRequestItem({ baseSha: 'previous-base' }),
  }
}

const conflictWorktree: PreparedConflictWorktree = {
  path: '/tmp/conflict-worktree',
  headSha: 'head-sha',
  baseSha: 'current-base',
  conflictedFiles: ['src/a.ts'],
}

const batchIssues = [{
  taskId: 't1',
  issueNumber: 101,
  title: 'A',
  body: 'Body A',
  triageSummary: 'Summary A',
  relatedIssues: [],
  target: 'src/a.ts',
}]

/**
 * Every prompt builder that may receive the project memory index.
 *
 * A turn that judges existing work reads Harlan's recorded decisions, so it
 * never relitigates one. A turn that invents new work or runs without tools
 * gets none, so the list below states both answers.
 */
const withMemory = {
  adversarialReview: (value: RepositoryMemory | null) => reviewPrompt(
    reviewTask(),
    reviewSnapshot(),
    '/tmp/review-worktree',
    { _tag: 'Authorized' as const },
    [],
    value,
  ),
  issueTriage: (value: RepositoryMemory | null) => issuePrompt(
    issueTriageTask(),
    { body: 'Body', comments: [] },
    '/tmp/issue-worktree',
    value,
  ),
  conflictResolution: (value: RepositoryMemory | null) => conflictResolutionPrompt(conflictTask(), conflictWorktree, value),
  batchPlan: (value: RepositoryMemory | null) => batchPlanPrompt({
    repository: 'harlan-zw/example',
    issues: batchIssues,
    memory: value,
  }),
}

describe('project memory in Agent prompts', () => {
  for (const [name, build] of Object.entries(withMemory)) {
    it(`names the memory index for the ${name} turn`, () => {
      const prompt = build(memory)

      expect(prompt).toContain(memory.indexPath)
      expect(prompt).toContain('Read a linked file when its entry matters to your work.')
      expect(prompt).toContain('Check it against the code before you rely on it.')
    })

    it(`says nothing about memory for the ${name} turn without it`, () => {
      const prompt = build(null)

      expect(prompt).not.toContain('memory')
      expect(prompt).not.toContain('MEMORY.md')
    })
  }

  it('lets the read only Review open the notes outside its worktree', () => {
    expect(withMemory.adversarialReview(memory))
      .toContain('The memory index and its notes are the only read allowed outside the worktree.')
    expect(withMemory.adversarialReview(memory)).toContain('Keep the worktree read only.')
  })

  it('withholds memory from a Routine scan, which proposes new work', () => {
    const prompt = routineScanPrompt({ mode: 'propose', name: 'pr-triage', rejected: [], repository: 'harlan-zw/example' })

    expect(prompt).not.toContain('MEMORY.md')
    expect(prompt).toContain('These proposals were rejected before.')
  })

  it('withholds memory from Pull request triage, which may use no tools', () => {
    const prompt = pullRequestTriagePrompt(reviewTask(), ['README.md'])

    expect(prompt).not.toContain('MEMORY.md')
    expect(prompt).toContain('Do not use tools or inspect the repository.')
  })
})
