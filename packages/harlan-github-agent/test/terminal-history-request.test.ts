import { expect, it } from 'vitest'
import { terminalEarlierRequest } from '../dashboard/app/utils/terminal-history-request.ts'

it('restores a saved history page for an ended session without a cached screen', () => {
  expect(terminalEarlierRequest({
    ended: true,
    historySupported: true,
    reading: { snapshot: 'saved-copy', offset: 1113 },
  })).toEqual({ type: 'History', snapshot: 'saved-copy', offset: 1113, limit: 200 })
})

it('does not request a replacement from an ended helper after returning to the last screen', () => {
  expect(terminalEarlierRequest({
    ended: true,
    historySupported: true,
    reading: null,
    screen: { dimensions: { cols: 80, rows: 24 }, scrollbackLength: 1000 },
  })).toBeUndefined()
})

it('pages the saved copy without a screen and keeps the live scrollback cell limit', () => {
  expect(terminalEarlierRequest({
    ended: true,
    historySupported: true,
    history: { snapshot: 'saved-copy', offset: 400 },
    reading: { snapshot: 'saved-copy', offset: 410 },
  })).toEqual({ type: 'History', snapshot: 'saved-copy', offset: 200, limit: 200 })
  expect(terminalEarlierRequest({
    ended: false,
    historySupported: false,
    reading: null,
    screen: { dimensions: { cols: 500, rows: 24 }, scrollbackLength: 1000 },
  })).toEqual({ type: 'Scrollback', offset: 960, limit: 40 })
})
