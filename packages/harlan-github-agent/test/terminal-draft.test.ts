import type { TerminalInput } from '../src/terminal-protocol.ts'
import { expect, it } from 'vitest'
import { submitTerminalDraft } from '../dashboard/app/utils/terminal-draft.ts'

const enter: TerminalInput = { type: 'Key', event: { action: 1, key: 58, mods: 0 } }

it('sends the edited phone draft once, then submits it', () => {
  const sent: TerminalInput[] = []
  expect(submitTerminalDraft('Phones work. 中文\nSecond line', enter, (value) => {
    sent.push(value)
    return true
  })).toBe('Submitted')
  expect(sent).toEqual([{ type: 'Paste', text: 'Phones work. 中文\nSecond line' }, enter])
})

it('does not submit when draft delivery fails', () => {
  const sent: TerminalInput[] = []
  expect(submitTerminalDraft('Keep my draft', enter, (value) => {
    sent.push(value)
    return false
  })).toBe('Rejected')
  expect(sent).toEqual([{ type: 'Paste', text: 'Keep my draft' }])
})

it('sends Enter for an empty draft so terminal prompts remain usable', () => {
  const sent: TerminalInput[] = []
  expect(submitTerminalDraft('', enter, (value) => {
    sent.push(value)
    return true
  })).toBe('Submitted')
  expect(sent).toEqual([enter])
})

it('marks a delivered draft as pasted when Enter fails, preventing a repeated paste', () => {
  expect(submitTerminalDraft('Already delivered', enter, value => value.type === 'Paste')).toBe('Pasted')
})
