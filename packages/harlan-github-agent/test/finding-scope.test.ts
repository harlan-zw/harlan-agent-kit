import type { ChangedLines } from '../src/finding-scope.ts'
import type { ReviewFinding } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { addedHeadLines, changedLinesFromComparison, findingScope, withFindingScopes } from '../src/finding-scope.ts'

const patch = [
  '@@ -10,4 +10,5 @@ export function parse() {',
  '   const a = 1',
  '-  const b = 2',
  '+  const b = 3',
  '+  const c = 4',
  '   return a',
  '@@ -40,2 +41,3 @@',
  '   one',
  '+  two',
  '   three',
  '\\ No newline at end of file',
].join('\n')

function diff(files: ChangedLines['files'], complete = true): ChangedLines {
  return { files, complete }
}

const changed = diff([{ _tag: 'Changed', path: 'src/parser.ts', previousPath: null, added: addedHeadLines(patch) }])

describe('the head lines one patch adds', () => {
  it('counts only added lines on the head side, across hunks', () => {
    expect([...addedHeadLines(patch)]).toEqual([11, 12, 42])
  })

  it('adds nothing for a patch that only removes lines', () => {
    expect([...addedHeadLines('@@ -1,2 +0,0 @@\n-one\n-two')]).toEqual([])
  })
})

describe('finding scope', () => {
  it('reads an added line as this change', () => {
    expect(findingScope({ path: 'src/parser.ts', line: 12 }, changed)).toBe('change')
  })

  it('reads an unchanged line in a changed file as existing code', () => {
    expect(findingScope({ path: 'src/parser.ts', line: 10 }, changed)).toBe('existing')
  })

  it('reads a file this change never touched as existing code', () => {
    expect(findingScope({ path: 'src/other.ts', line: 3 }, changed)).toBe('existing')
  })

  it('leaves a finding without a line unknown', () => {
    expect(findingScope({ path: 'src/parser.ts', line: null }, changed)).toBeUndefined()
  })

  it('leaves every finding unknown when the diff is unavailable', () => {
    expect(findingScope({ path: 'src/parser.ts', line: 12 }, null)).toBeUndefined()
  })

  it('reads a renamed file by its new path, and leaves its old path unknown', () => {
    const renamed = diff([{ _tag: 'Changed', path: 'src/reader.ts', previousPath: 'src/parser.ts', added: new Set([5]) }])
    expect(findingScope({ path: 'src/reader.ts', line: 5 }, renamed)).toBe('change')
    expect(findingScope({ path: 'src/reader.ts', line: 6 }, renamed)).toBe('existing')
    expect(findingScope({ path: 'src/parser.ts', line: 5 }, renamed)).toBeUndefined()
  })

  it('leaves a file unknown when GitHub sent no patch for its additions', () => {
    expect(findingScope({ path: 'src/huge.ts', line: 5 }, diff([{ _tag: 'Unreadable', path: 'src/huge.ts' }]))).toBeUndefined()
  })

  it('leaves a missing path unknown when the file list may be cut', () => {
    expect(findingScope({ path: 'src/other.ts', line: 3 }, diff([], false))).toBeUndefined()
  })

  it('leaves a removed file unknown', () => {
    expect(findingScope({ path: 'src/gone.ts', line: 3 }, diff([{ _tag: 'Removed', path: 'src/gone.ts' }]))).toBeUndefined()
  })
})

describe('gitHub comparison', () => {
  it('parses a rename without a patch as a file with no added lines', () => {
    const parsed = changedLinesFromComparison({ files: [
      { filename: 'src/reader.ts', previous_filename: 'src/parser.ts', status: 'renamed', additions: 0 },
      { filename: 'src/parser.test.ts', status: 'modified', additions: 2, patch: '@@ -1 +1,2 @@\n one\n+two' },
      { filename: 'src/image.png', status: 'modified', additions: 1 },
      { filename: 'src/gone.ts', status: 'removed', additions: 0 },
    ] })
    expect(parsed._tag).toBe('Ok')
    if (parsed._tag !== 'Ok')
      return
    expect(parsed.value.complete).toBe(true)
    expect(findingScope({ path: 'src/reader.ts', line: 1 }, parsed.value)).toBe('existing')
    expect(findingScope({ path: 'src/parser.test.ts', line: 2 }, parsed.value)).toBe('change')
    expect(findingScope({ path: 'src/image.png', line: 1 }, parsed.value)).toBeUndefined()
    expect(findingScope({ path: 'src/gone.ts', line: 1 }, parsed.value)).toBeUndefined()
  })

  it('marks a list of 300 files as possibly cut', () => {
    const files = Array.from({ length: 300 }, (_, index) => ({ filename: `src/${index}.ts`, status: 'added', additions: 1, patch: '@@ -0,0 +1 @@\n+one' }))
    const parsed = changedLinesFromComparison({ files })
    expect(parsed._tag === 'Ok' && parsed.value.complete).toBe(false)
  })

  it('refuses a response without a file list', () => {
    expect(changedLinesFromComparison({ files: 'none' })._tag).toBe('Err')
  })
})

describe('scoped follow-ups', () => {
  const logged = (path: string, line: number | null): ReviewFinding => ({
    _tag: 'Logged',
    impact: 50,
    summary: 'Buffered bytes drop',
    nextAction: 'Keep them.',
    details: { fingerprint: 'f'.repeat(64), identity: 'bytes', location: { path, line }, proof: 'A split loses bytes.' },
  })

  it('stores the scope on Logged findings only, and stores none when it is unknown', () => {
    const open: ReviewFinding = { _tag: 'Open', impact: 90, summary: 'Crash', nextAction: 'Fix it.' }
    const [added, unchanged, unknown, blocking] = withFindingScopes([logged('src/parser.ts', 11), logged('src/parser.ts', 10), logged('src/parser.ts', null), open], changed)
    expect(added?._tag === 'Logged' && added.details.scope).toBe('change')
    expect(unchanged?._tag === 'Logged' && unchanged.details.scope).toBe('existing')
    expect(unknown?._tag === 'Logged' && 'scope' in unknown.details).toBe(false)
    expect(blocking).toEqual(open)
  })
})
