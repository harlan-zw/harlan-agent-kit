import type { TerminalInput } from '../src/terminal-protocol.ts'
import { describe, expect, it } from 'vitest'
import { advanceTerminalSubmission, beginTerminalSubmission, endTerminalSubmission, interruptTerminalSubmission } from '../dashboard/app/utils/terminal-submission.ts'

const enter: TerminalInput = { type: 'Key', event: { action: 1, key: 58, mods: 0 } }
describe('phone terminal delivery', () => {
  it('waits for the paste receipt before pressing Enter, then waits for its receipt', () => {
    const pending = beginTerminalSubmission('Keep my words', enter, 'writer', { _tag: 'Ok', value: 4 })
    expect(pending).toMatchObject({ _tag: 'Pending', phase: 'Paste', text: 'Keep my words' })
    expect(advanceTerminalSubmission(pending, 4, 'other')).toEqual({ state: pending })
    const pasted = advanceTerminalSubmission(pending, 4, 'writer')
    expect(pasted).toMatchObject({ state: { _tag: 'Pasted', text: 'Keep my words' }, send: enter })
    const submitted = beginTerminalSubmission('Keep my words', enter, 'writer', { _tag: 'Ok', value: 5 }, true)
    expect(advanceTerminalSubmission(submitted, 5, 'writer')).toEqual({ state: { _tag: 'Acknowledged', text: 'Keep my words' } })
  })
  it('keeps a refused draft editable without sending Enter', () => {
    expect(beginTerminalSubmission('Retry this', enter, 'writer', { _tag: 'Err', reason: 'SizeLimit' }))
      .toEqual({ _tag: 'Editing' })
  })
  it('does not paste again when only Enter failed', () => {
    expect(beginTerminalSubmission('Already pasted', enter, 'writer', { _tag: 'Err', reason: 'SessionUnavailable' }, true))
      .toEqual({ _tag: 'Pasted', text: 'Already pasted', enter })
  })
  it('preserves uncertain input and never schedules a retry', () => {
    const pending = beginTerminalSubmission('May have arrived', enter, 'writer', { _tag: 'Ok', value: 3 })
    const unknown = interruptTerminalSubmission(pending)
    expect(unknown).toEqual({ _tag: 'Unknown', text: 'May have arrived' })
    expect(advanceTerminalSubmission(unknown, 3, 'writer')).toEqual({ state: unknown })
    expect(interruptTerminalSubmission({ _tag: 'Editing' })).toEqual({ _tag: 'Editing' })
  })
  it('treats a thrown transport write as unknown even before a receipt exists', () => {
    expect(beginTerminalSubmission('Uncertain', enter, 'writer', { _tag: 'Err', reason: 'DeliveryUnknown' }))
      .toEqual({ _tag: 'Unknown', text: 'Uncertain' })
  })
  it('acknowledges an empty Enter without a paste', () => {
    const pending = beginTerminalSubmission('', enter, 'writer', { _tag: 'Ok', value: 1 })
    expect(advanceTerminalSubmission(pending, 1, 'writer')).toEqual({ state: { _tag: 'Acknowledged', text: '' } })
  })
})

it('makes an ended Session draft recoverable after paste or interrupted delivery', () => {
  expect(endTerminalSubmission({ _tag: 'Pasted', text: 'Keep this', enter })).toEqual({ _tag: 'Editing' })
  const pending = beginTerminalSubmission('Check first', enter, 'writer', { _tag: 'Ok', value: 1 })
  expect(endTerminalSubmission(pending)).toEqual({ _tag: 'Unknown', text: 'Check first' })
})
