import { expect, it } from 'vitest'
import { parseTerminalServerMessage } from '../dashboard/app/utils/terminal-protocol.ts'
import { applyTerminalScreen } from '../dashboard/app/utils/terminal-screen.ts'

const cell = {
  codepoint: 32,
  fg_r: 255,
  fg_g: 255,
  fg_b: 255,
  bg_r: 0,
  bg_g: 0,
  bg_b: 0,
  flags: 0,
  width: 1,
  hyperlink_id: 0,
  grapheme_len: 0,
}
const modes = { alternate: false, paste: false, focus: false, mouse: false, keyboard: 0 }
const screen = {
  revision: 1,
  scrollbackLength: 0,
  dimensions: { cols: 2, rows: 2 },
  lines: [
    [cell, cell],
    [cell, cell],
  ],
  graphemes: [
    [' ', ' '],
    [' ', ' '],
  ],
  wrapped: [false, false],
  cursor: { x: 0, y: 0, visible: true },
  modes,
}
const rows = {
  type: 'Rows',
  generation: 'g',
  baseRevision: 1,
  revision: 2,
  rows: [{ index: 1, cells: [cell, cell], graphemes: ['👩‍💻', ' '], wrapped: true }],
  cursor: { x: 1, y: 1, visible: false },
  modes: { ...modes, keyboard: 11 },
  scrollbackLength: 4,
}

it('projects rows and applies Unicode without mutating the previous screen', () => {
  const parsed = parseTerminalServerMessage({ ...rows, private: 'secret' })
  expect(parsed).toEqual({ _tag: 'Ok', value: rows })
  if (parsed._tag !== 'Ok' || parsed.value.type !== 'Rows') throw new Error('Rows parsing failed')
  const result = applyTerminalScreen(screen, parsed.value, 'g')
  expect(result).toEqual({
    _tag: 'Ok',
    value: {
      ...screen,
      revision: 2,
      lines: [screen.lines[0], rows.rows[0]!.cells],
      graphemes: [screen.graphemes[0], rows.rows[0]!.graphemes],
      wrapped: [false, true],
      cursor: rows.cursor,
      modes: rows.modes,
      scrollbackLength: 4,
    },
  })
  expect(screen.revision).toBe(1)
  expect(screen.graphemes[1]).toEqual([' ', ' '])
})
it.each([
  { rows: [rows.rows[0], rows.rows[0]] },
  { rows: [{ ...rows.rows[0], index: -1 }] },
  { rows: [{ ...rows.rows[0], cells: [cell], graphemes: [' '] }] },
  { revision: 1 },
  { rows: [{ ...rows.rows[0], graphemes: ['\uD800', ' '] }] },
  { cursor: { x: 500, y: 0, visible: true } },
])('rejects malformed rows: %o', (change) => {
  expect(parseTerminalServerMessage({ ...rows, ...change })).toEqual({ _tag: 'Err', reason: 'InvalidRequest' })
})
it('refuses absent, skipped, or stale snapshots and never applies partial changes', () => {
  const parsed = parseTerminalServerMessage(rows)
  if (parsed._tag !== 'Ok' || parsed.value.type !== 'Rows') throw new Error('Rows parsing failed')
  expect(applyTerminalScreen(undefined, parsed.value, 'g')).toEqual({ _tag: 'Err', reason: 'DeliveryUnknown' })
  expect(applyTerminalScreen({ ...screen, revision: 0 }, parsed.value, 'g')).toEqual({
    _tag: 'Err',
    reason: 'DeliveryUnknown',
  })
  expect(applyTerminalScreen(screen, parsed.value, 'other')).toEqual({ _tag: 'Err', reason: 'StaleGeneration' })
  expect(applyTerminalScreen(screen, { ...parsed.value, rows: [{ ...parsed.value.rows[0]!, index: 2 }] }, 'g')).toEqual(
    { _tag: 'Err', reason: 'InvalidRequest' },
  )
  expect(applyTerminalScreen(screen, { ...parsed.value, cursor: { x: 2, y: 0, visible: true } }, 'g')).toEqual({
    _tag: 'Err',
    reason: 'InvalidRequest',
  })
  expect(
    applyTerminalScreen(screen, { ...parsed.value, rows: [{ ...parsed.value.rows[0]!, cells: [cell] }] }, 'g'),
  ).toEqual({ _tag: 'Err', reason: 'InvalidRequest' })
  const applied = applyTerminalScreen(screen, parsed.value, 'g')
  if (applied._tag !== 'Ok') throw new Error('Initial delta failed')
  expect(applyTerminalScreen(applied.value, parsed.value, 'g')).toEqual({ _tag: 'Err', reason: 'DeliveryUnknown' })
})
it('bounds total delta cells before projecting oversized rows', () => {
  const largeRows = Array.from({ length: 41 }, (_, index) => ({
    index,
    cells: Array.from({ length: 500 }).fill(cell),
    graphemes: Array.from({ length: 500 }).fill(' '),
    wrapped: false,
  }))
  expect(parseTerminalServerMessage({ ...rows, rows: largeRows })).toEqual({ _tag: 'Err', reason: 'SizeLimit' })
})
it('accepts cursor-only updates and full snapshots that change dimensions', () => {
  const parsed = parseTerminalServerMessage({ ...rows, rows: [] })
  if (parsed._tag !== 'Ok' || parsed.value.type !== 'Rows') throw new Error('Rows parsing failed')
  expect(applyTerminalScreen(screen, parsed.value, 'g')).toMatchObject({
    _tag: 'Ok',
    value: { revision: 2, cursor: rows.cursor },
  })
  expect(applyTerminalScreen(undefined, { type: 'Screen', generation: 'g', screen }, 'g')).toEqual({
    _tag: 'Ok',
    value: screen,
  })
})
