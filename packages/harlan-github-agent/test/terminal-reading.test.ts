import { expect, it } from 'vitest'
import { terminalReadingPosition } from '../dashboard/app/utils/terminal-reading.ts'

it('restores the same visible line after earlier pages have been prepended', () => {
  expect(terminalReadingPosition(0, 2505, 20)).toEqual(terminalReadingPosition(100, 505, 20))
  expect(terminalReadingPosition(100, 505, 20)).toEqual({ offset: 115, top: 205 })
})
it('keeps the beginning reachable and ignores elastic overscroll', () => {
  expect(terminalReadingPosition(0, -30, 20)).toEqual({ offset: 0, top: 0 })
  expect(terminalReadingPosition(0, 45, 20)).toEqual({ offset: 0, top: 45 })
})
