import { parseDiffFromFile } from '@pierre/diffs'
import { describe, expect, it } from 'vitest'
import {
  parseTerminalDiffContent,
  parseTerminalDiffInventory,
  prepareTerminalDiffContent,
  terminalDiffParseOptions,
} from '../dashboard/app/utils/terminal-diff.ts'

const id = 'a'.repeat(64)
const base = 'b'.repeat(40)
const inventory = { id, base, source: { _tag: 'Working' }, files: [{ path: 'new\nfile.ts', status: '??' }] }
const content = { path: 'new\nfile.ts', generation: id, oldText: '', newText: '中👩‍💻\n' }
const invalid = { _tag: 'Err', error: 'InvalidRequest' }
describe('terminal diff browser boundary', () => {
  it('projects server inventory fields and preserves raw Git status and newline paths', () => {
    expect(
      parseTerminalDiffInventory({
        _tag: 'Ok',
        value: { ...inventory, root: 'secret', files: [{ ...inventory.files[0], stamp: 'secret' }] },
      }),
    ).toEqual({ _tag: 'Ok', value: inventory })
  })
  it('accepts precise staged and comparison sources', () => {
    for (const source of [{ _tag: 'Staged' }, { _tag: 'Comparison', base, head: id }]) {
      expect(parseTerminalDiffInventory({ _tag: 'Ok', value: { ...inventory, source } })).toEqual({
        _tag: 'Ok',
        value: { ...inventory, source },
      })
    }
  })
  it.each([
    { id: 'g'.repeat(64) },
    { base: 'main' },
    { source: { _tag: 'comparison' } },
    { source: { _tag: 'Comparison', base, head: 'HEAD' } },
    { files: [{ path: 'x\0', status: 'M' }] },
    { files: [{ path: 'x', status: 'too long' }] },
    { files: [inventory.files[0], inventory.files[0]] },
  ])('rejects malformed inventory %o', (change) => {
    expect(parseTerminalDiffInventory({ _tag: 'Ok', value: { ...inventory, ...change } })).toEqual(invalid)
  })
  it('bounds inventories before rendering', () => {
    expect(
      parseTerminalDiffInventory({
        _tag: 'Ok',
        value: { ...inventory, files: Array.from({ length: 501 }).fill(inventory.files[0]) },
      }),
    ).toEqual({ _tag: 'Err', error: 'TooLarge' })
  })
  it('preserves empty text, Unicode, and the selected file identity', () => {
    expect(parseTerminalDiffContent({ _tag: 'Ok', value: { ...content, token: 'secret' } }, content.path)).toEqual({
      _tag: 'Ok',
      value: content,
    })
    expect(parseTerminalDiffContent({ _tag: 'Ok', value: content }, 'other.ts')).toEqual(invalid)
    expect(parseTerminalDiffContent({ _tag: 'Ok', value: { ...content, generation: 'head' } }, content.path)).toEqual(
      invalid,
    )
  })
  it('bounds each side by UTF8 bytes and rejects binary text', () => {
    expect(
      parseTerminalDiffContent({ _tag: 'Ok', value: { ...content, newText: '中'.repeat(700_000) } }, content.path),
    ).toEqual({ _tag: 'Err', error: 'TooLarge' })
    expect(parseTerminalDiffContent({ _tag: 'Ok', value: { ...content, oldText: '\0' } }, content.path)).toEqual(
      invalid,
    )
  })
  it.each(['InvalidRequest', 'Unavailable', 'TooLarge', 'Binary', 'Symlink', 'Changed'])(
    'preserves known server failure %s',
    (error) => {
      expect(parseTerminalDiffInventory({ _tag: 'Err', error })).toEqual({ _tag: 'Err', error })
      expect(parseTerminalDiffContent({ _tag: 'Err', error }, content.path)).toEqual({ _tag: 'Err', error })
    },
  )
  it('rejects forged failure reasons and success tags', () => {
    expect(parseTerminalDiffInventory({ _tag: 'Err', error: 'Unknown' })).toEqual(invalid)
    expect(parseTerminalDiffContent({ _tag: 'Ok', value: null }, content.path)).toEqual(invalid)
  })
  it('bounds rendering separately from server file downloads', () => {
    expect(prepareTerminalDiffContent(content)).toEqual({ _tag: 'Ok', value: content })
    expect(prepareTerminalDiffContent({ ...content, newText: 'x'.repeat(256 * 1024 + 1) })).toEqual({
      _tag: 'Err',
      error: 'TooLarge',
    })
    expect(prepareTerminalDiffContent({ ...content, newText: '\n'.repeat(10_000) })).toEqual({
      _tag: 'Err',
      error: 'TooLarge',
    })
  })
  it('computes a normal diff through the same bounded parser options', () => {
    const diff = parseDiffFromFile(
      { name: 'file.ts', contents: 'before\n' },
      { name: 'file.ts', contents: 'after\n' },
      terminalDiffParseOptions,
    )
    expect(diff.hunks[0]?.additionCount).toBe(1)
    expect(diff.hunks[0]?.deletionCount).toBe(1)
  })
  it('aborts a pathological diff through the pinned public parser within its time limit', () => {
    const oldFile = {
      name: 'file.txt',
      contents: Array.from({ length: 9000 }, (_, index) => `old-${index}\n`).join(''),
    }
    const newFile = {
      name: 'file.txt',
      contents: Array.from({ length: 9000 }, (_, index) => `new-${index}\n`).join(''),
    }
    const start = performance.now()
    expect(() => parseDiffFromFile(oldFile, newFile, terminalDiffParseOptions)).toThrow()
    expect(performance.now() - start).toBeLessThan(1500)
  })
})
