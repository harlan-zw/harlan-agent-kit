import type { ClaimedIssueWorkTask } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { parseStoredIssueTriage } from '../src/issue-triage.ts'
import { issueWorkPrompt } from '../src/issue-work-worker.ts'
import { issueItem, repositoryMapping } from './fixtures.ts'

function task(): ClaimedIssueWorkTask {
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

const storedTriage = JSON.stringify({
  _tag: 'READY_TO_IMPLEMENT',
  difficulty: 2,
  impact: 4,
  hasReproduction: true,
  needsCodebaseReview: false,
  summary: 'The parser drops the last byte of a chunked body.',
  nextAction: 'Keep the trailing byte in src/parser.ts and cover it in test/parser.test.ts.',
})

describe('issueWorkPrompt', () => {
  it('carries the stored triage summary and next action so the Agent does not triage twice', () => {
    const prompt = issueWorkPrompt({
      task: task(),
      body: 'Body',
      comments: [],
      template: { _tag: 'Missing' },
      routineSource: null,
      triage: parseStoredIssueTriage(storedTriage),
      instructionFiles: [],
    })

    expect(prompt).toContain('Triage summary: The parser drops the last byte of a chunked body.')
    expect(prompt).toContain('Triage next action: Keep the trailing byte in src/parser.ts and cover it in test/parser.test.ts.')
    expect(prompt).toContain('Do not triage the issue again.')
  })

  it('says when no triage is stored instead of pointing at an absent one', () => {
    const prompt = issueWorkPrompt({
      task: task(),
      body: 'Body',
      comments: [],
      template: { _tag: 'Missing' },
      routineSource: null,
      triage: parseStoredIssueTriage(null),
      instructionFiles: [],
    })

    expect(prompt).toContain('No stored Issue triage exists for this issue state.')
    expect(prompt).not.toContain('Triage summary:')
  })

  it('names the check budget, the toolchain, and the inlined skill cores instead of skill loads', () => {
    const prompt = issueWorkPrompt({
      task: task(),
      body: 'Body',
      comments: [],
      template: { _tag: 'Missing' },
      routineSource: null,
      triage: null,
      instructionFiles: ['AGENTS.md'],
    })

    expect(prompt).toContain('Do not run the full test suite, the full typecheck, or a build. CI runs those.')
    expect(prompt).toContain('Failures outside the changed files are pre-existing. Do not stash changes to verify them.')
    expect(prompt).toContain('Use pnpm for every package command. Never use npx.')
    expect(prompt).toContain('Write the failing test first.')
    expect(prompt).toContain('pullRequestTitle is a Conventional Commit subject under 70 characters')
    expect(prompt).toContain('> 🤖 AI disclosure: [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) modified this description.')
    expect(prompt).toContain('Read these repository instruction files before you change code: AGENTS.md.')
    expect(prompt).not.toMatch(/Apply the (?:PR|unit-tests|humanize-writing) skill/)
  })
})

describe('parseStoredIssueTriage', () => {
  it.each([
    ['malformed JSON', '{'],
    ['an unknown route', JSON.stringify({ _tag: 'DONE', summary: 's', nextAction: 'n', difficulty: 1, impact: 1, hasReproduction: true, needsCodebaseReview: false })],
    ['a missing next action', JSON.stringify({ _tag: 'NEEDS_INFO', summary: 's', difficulty: 1, impact: 1, hasReproduction: true, needsCodebaseReview: false })],
  ])('rejects %s', (_label, evidence) => {
    expect(parseStoredIssueTriage(evidence)).toBeNull()
  })
})

describe('issueWorkPrompt memory', () => {
  it('names the memory index and how to treat it', () => {
    const prompt = issueWorkPrompt({
      task: task(),
      body: 'Body',
      comments: [],
      template: { _tag: 'Missing' },
      routineSource: null,
      triage: parseStoredIssueTriage(null),
      instructionFiles: [],
      memory: { indexPath: '/home/harlan/.claude/projects/-home-harlan-pkg-unhead/memory/MEMORY.md' },
    })

    expect(prompt).toContain('project memory index at /home/harlan/.claude/projects/-home-harlan-pkg-unhead/memory/MEMORY.md')
    expect(prompt).toContain('Check it against the code before you rely on it.')
  })

  it('says nothing about memory when the repository has none', () => {
    const prompt = issueWorkPrompt({
      task: task(),
      body: 'Body',
      comments: [],
      template: { _tag: 'Missing' },
      routineSource: null,
      triage: parseStoredIssueTriage(null),
      instructionFiles: [],
      memory: null,
    })

    expect(prompt).not.toContain('project memory index')
  })
})
