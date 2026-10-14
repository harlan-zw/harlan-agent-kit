import { describe, expect, it } from 'vitest'
import { parsePullRequestDiffInventory } from '../dashboard/app/utils/terminal-diff.ts'

const value = {
  id: 'a'.repeat(64),
  base: 'b'.repeat(40),
  source: { _tag: 'Comparison', base: 'b'.repeat(40), head: 'c'.repeat(40) },
  files: [{ path: 'file.txt', status: 'M' }],
  coverage: { _tag: 'Complete' },
}
describe('pull request diff browser boundary', () => {
  it('preserves incomplete coverage and strips private server fields', () => {
    const coverage = { _tag: 'Incomplete', reason: 'GitHubFileLimit' }
    expect(parsePullRequestDiffInventory({ _tag: 'Ok', value: { ...value, coverage, credential: 'secret' } })).toEqual({
      _tag: 'Ok',
      value: { ...value, coverage },
    })
  })
  it.each([undefined, { _tag: 'Unknown' }, { _tag: 'Incomplete', reason: 'Unknown' }])(
    'refuses absent or forged coverage %o',
    (coverage) => {
      expect(parsePullRequestDiffInventory({ _tag: 'Ok', value: { ...value, coverage } })).toEqual({
        _tag: 'Err',
        error: 'InvalidRequest',
      })
    },
  )
  it('bounds metadata bytes before rendering a large file list', () => {
    const files = Array.from({ length: 3000 }, (_, index) => ({ path: `${'a'.repeat(400)}-${index}`, status: 'A' }))
    const result = parsePullRequestDiffInventory({ _tag: 'Ok', value: { ...value, files } })
    expect(result._tag).toBe('Err')
    if (result._tag === 'Err') expect(result.error).toBe('TooLarge')
  })
})
