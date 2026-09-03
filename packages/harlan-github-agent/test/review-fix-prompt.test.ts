import type { ClaimedReviewFixTask, ReviewFinding } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { reviewFixPrompt } from '../src/review-fix-worker.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

function task(): ClaimedReviewFixTask {
  const pullRequest = pullRequestItem({ mergeState: 'clean' })
  const mapping = repositoryMapping({ ownership: 'maintained' })
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

const findings: ReviewFinding[] = [{
  _tag: 'Open',
  summary: 'The parser drops buffered bytes.',
  nextAction: 'Preserve all buffered bytes.',
}]

describe('reviewFixPrompt', () => {
  it('names the check budget and inlines the unit test rules instead of a skill load', () => {
    const prompt = reviewFixPrompt({ task: task(), findings, instructionFiles: [] })

    expect(prompt).toContain('Check budget: run the regression test file, its direct dependants, and lint and typecheck on the changed files only.')
    expect(prompt).toContain('Do not run the full test suite, the full typecheck, or a build. CI runs those.')
    expect(prompt).toContain('Failures outside the changed files are pre-existing. Do not stash changes to verify them.')
    expect(prompt).toContain('Use pnpm for every package command. Never use npx.')
    expect(prompt).toContain('Never add debug output to tracked files.')
    expect(prompt).toContain('Delete a test that can fail while the code is correct.')
    expect(prompt).not.toContain('unit-tests skill')
  })

  it.each([
    [['AGENTS.md', 'CLAUDE.md'], 'Read these repository instruction files before you change code: AGENTS.md, CLAUDE.md.'],
    [[], 'This repository has no AGENTS.md, CLAUDE.md, .github/copilot-instructions.md. Do not search for one.'],
  ])('reflects instruction files %j', (instructionFiles, line) => {
    expect(reviewFixPrompt({ task: task(), findings, instructionFiles })).toContain(line)
  })
})
