import { expect, it } from 'vitest'
import { terminalHistoryAfterLatest, terminalHistoryAfterPage } from '../dashboard/app/utils/terminal-history-memory.ts'
import { terminalAttachmentHistoryRequest, terminalEarlierRequest } from '../dashboard/app/utils/terminal-history-request.ts'

it('restores a saved history page for an ended session without a cached screen', () => {
  expect(terminalEarlierRequest({
    ended: true,
    historySupported: true,
    reading: { snapshot: 'saved-copy', offset: 1113 },
  })).toEqual({ type: 'History', snapshot: 'saved-copy', offset: 1113, limit: 200 })
})

it('restores a retained snapshot when an ended viewer attaches after reload', () => {
  expect(terminalAttachmentHistoryRequest({
    ended: true,
    historySupported: true,
    reading: null,
    retainedSnapshot: 'saved-copy',
  })).toEqual({ type: 'History', snapshot: 'saved-copy', offset: null, limit: 200 })
})

it('restores an archive after Latest, exit, and remount without a cached screen', () => {
  const captured = terminalHistoryAfterPage({ reading: { snapshot: 'saved-copy', offset: 1113, top: 240 }, retainedSnapshot: null }, 'saved-copy')
  const latest = terminalHistoryAfterLatest(captured)

  expect(terminalAttachmentHistoryRequest({
    ended: true,
    historySupported: true,
    reading: latest.reading,
    retainedSnapshot: latest.retainedSnapshot,
  })).toEqual({ type: 'History', snapshot: 'saved-copy', offset: null, limit: 200 })
})

it('does not request a replacement from an ended helper after returning to the last screen', () => {
  expect(terminalEarlierRequest({
    ended: true,
    historySupported: true,
    reading: null,
    screen: { dimensions: { cols: 80, rows: 24 }, scrollbackLength: 1000 },
  })).toBeUndefined()
})

it('restores the retained snapshot after Latest for an ended session', () => {
  expect(terminalEarlierRequest({
    ended: true,
    historySupported: true,
    reading: null,
    retainedSnapshot: 'saved-copy',
  })).toEqual({ type: 'History', snapshot: 'saved-copy', offset: null, limit: 200 })
})

it('does not restore retained output for a running session', () => {
  expect(terminalEarlierRequest({
    ended: false,
    historySupported: true,
    reading: null,
    retainedSnapshot: 'saved-copy',
    screen: { dimensions: { cols: 80, rows: 24 }, scrollbackLength: 1000 },
  })).toEqual({ type: 'History', snapshot: null, offset: null, limit: 200 })
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
