import type { MergeRisk, MergeRiskPolicy, PullRequestFile } from '../src/merge-risk.ts'
import { describe, expect, it } from 'vitest'
import { combineMergeRisk, matchesGlob, mergeRiskFloor } from '../src/merge-risk.ts'

const policy: MergeRiskPolicy = {
  containedPaths: [],
  maximumChangedFiles: 12,
  maximumChangedLines: 300,
  requireTestChange: false,
  sensitivePaths: [],
}

function file(path: string, overrides: Partial<PullRequestFile> = {}): PullRequestFile {
  return { additions: 5, deletions: 2, path, previousFilename: null, status: 'modified', ...overrides }
}

describe('the deterministic floor', () => {
  it('contains an ordinary small change', () => {
    expect(mergeRiskFloor([file('src/engine.ts')], policy)._tag).toBe('Contained')
  })

  it('never contains a file an agent reads as instructions', () => {
    for (const path of ['CLAUDE.md', 'skills/pr/SKILL.md', 'AGENTS.md', '.github/workflows/test.yml', '.claude/settings.json']) {
      const risk = mergeRiskFloor([file(path)], policy)
      expect(risk._tag, path).toBe('Sensitive')
    }
  })

  it('holds the instruction floor even when a repository allows the path', () => {
    // The repository cannot opt out of this one by widening its own globs.
    const permissive = { ...policy, containedPaths: ['**'], sensitivePaths: [] }
    expect(mergeRiskFloor([file('CLAUDE.md')], permissive)._tag).toBe('Sensitive')
  })

  it('marks a repository-named sensitive path Sensitive', () => {
    const risk = mergeRiskFloor([file('src/db/migrations/001.sql')], { ...policy, sensitivePaths: ['**/migrations/**'] })
    expect(risk._tag).toBe('Sensitive')
  })

  it('refuses a pull request with more files than the repository allows', () => {
    const files = Array.from({ length: 13 }, (_, index) => file(`src/file-${index}.ts`))
    const risk = mergeRiskFloor(files, policy)
    expect(risk._tag).toBe('Reviewable')
    if (risk._tag === 'Reviewable')
      expect(risk.reason).toContain('13 files')
  })

  it('refuses a pull request larger than the line limit', () => {
    const risk = mergeRiskFloor([file('src/a.ts', { additions: 400, deletions: 0 })], policy)
    expect(risk._tag).toBe('Reviewable')
    if (risk._tag === 'Reviewable')
      expect(risk.reason).toContain('400 lines')
  })

  it('refuses a delete or a rename, because a caller outside the diff may still reference it', () => {
    expect(mergeRiskFloor([file('src/a.ts', { status: 'removed' })], policy)._tag).toBe('Reviewable')
    expect(mergeRiskFloor([file('src/b.ts', { status: 'renamed', previousFilename: 'src/a.ts' })], policy)._tag).toBe('Reviewable')
  })

  it('refuses a path outside the allowlist when the repository sets one', () => {
    const scoped = { ...policy, containedPaths: ['src/**', 'test/**'] }
    expect(mergeRiskFloor([file('src/a.ts')], scoped)._tag).toBe('Contained')
    expect(mergeRiskFloor([file('scripts/deploy.sh')], scoped)._tag).toBe('Reviewable')
  })

  it('refuses a change with no test beside it when the repository asks for one', () => {
    const strict = { ...policy, requireTestChange: true }
    expect(mergeRiskFloor([file('src/a.ts')], strict)._tag).toBe('Reviewable')
    expect(mergeRiskFloor([file('src/a.ts'), file('test/a.test.ts')], strict)._tag).toBe('Contained')
  })

  it('refuses an empty pull request rather than containing it', () => {
    expect(mergeRiskFloor([], policy)._tag).toBe('Reviewable')
  })
})

describe('combining the floor with the Agent claim', () => {
  const contained: MergeRisk = { _tag: 'Contained' }
  const reviewable: MergeRisk = { _tag: 'Reviewable', reason: 'it changes a shared default' }
  const sensitive: MergeRisk = { _tag: 'Sensitive', reason: 'it runs a migration' }

  it('contains only when both the code and the Agent contain it', () => {
    expect(combineMergeRisk(contained, contained)._tag).toBe('Contained')
  })

  it('lets the Agent raise a verdict the paths call safe', () => {
    // The blast radius case: three lines, one shared default, every path small.
    expect(combineMergeRisk(contained, reviewable)).toEqual(reviewable)
    expect(combineMergeRisk(contained, sensitive)).toEqual(sensitive)
  })

  it('never lets the Agent lower the floor', () => {
    expect(combineMergeRisk(sensitive, contained)).toEqual(sensitive)
    expect(combineMergeRisk(reviewable, contained)).toEqual(reviewable)
    expect(combineMergeRisk(sensitive, reviewable)).toEqual(sensitive)
  })
})

describe('glob matching', () => {
  it('matches a single segment with one star', () => {
    expect(matchesGlob('src/*.ts', 'src/a.ts')).toBe(true)
    expect(matchesGlob('src/*.ts', 'src/nested/a.ts')).toBe(false)
  })

  it('crosses directories with two stars', () => {
    expect(matchesGlob('**/migrations/**', 'packages/db/migrations/001.sql')).toBe(true)
    expect(matchesGlob('src/**', 'src/a/b/c.ts')).toBe(true)
  })

  it('matches a file at the root through a leading double star', () => {
    expect(matchesGlob('**/*.sql', 'schema.sql')).toBe(true)
    expect(matchesGlob('**/*.sql', 'db/schema.sql')).toBe(true)
  })

  it('treats a regular expression character in the pattern as literal text', () => {
    expect(matchesGlob('src/index.ts', 'src/indexXts')).toBe(false)
    expect(matchesGlob('src/a+b.ts', 'src/a+b.ts')).toBe(true)
  })
})
