import { describe, expect, it } from 'vitest'
import { updatedAtLabel } from '../src/text.ts'

describe('updatedAtLabel', () => {
  it('reads as a clock time, not a machine timestamp', () => {
    expect(updatedAtLabel('2026-08-18T05:19:37.212Z')).toBe('2026-08-18 05:19 UTC')
  })

  it('drops the seconds and milliseconds nobody reads', () => {
    expect(updatedAtLabel('2026-08-18T00:00:00.000Z')).toBe('2026-08-18 00:00 UTC')
  })

  it('keeps a timestamp it cannot parse, rather than inventing one', () => {
    expect(updatedAtLabel('not a time')).toBe('not a time')
  })
})
