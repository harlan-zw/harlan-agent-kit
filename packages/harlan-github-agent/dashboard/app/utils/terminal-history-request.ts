import type { TerminalScreen } from '../../../src/terminal-protocol.ts'

const historyPageLimit = 200

interface Reading {
  snapshot?: string
  offset: number
}

interface History {
  snapshot?: string
  offset: number
}

export type TerminalEarlierRequest
  = | { type: 'History', snapshot: string | null, offset: number | null, limit: typeof historyPageLimit }
    | { type: 'Scrollback', offset: number, limit: number }

/** Restores the page a viewer had open when a terminal stream attaches. */
export function terminalAttachmentHistoryRequest(options: {
  ended: boolean
  historySupported: boolean
  reading: Reading | null
  retainedSnapshot?: string | null
  screen?: Pick<TerminalScreen, 'dimensions' | 'scrollbackLength'>
}): TerminalEarlierRequest | undefined {
  if (!options.reading?.snapshot && !(options.ended && options.retainedSnapshot))
    return undefined
  return terminalEarlierRequest(options)
}

/** Chooses a stable history page before requiring the live terminal screen. */
export function terminalEarlierRequest(options: {
  ended: boolean
  history?: History
  historySupported: boolean
  reading: Reading | null
  retainedSnapshot?: string | null
  screen?: Pick<TerminalScreen, 'dimensions' | 'scrollbackLength'>
}): TerminalEarlierRequest | undefined {
  const snapshot = options.history?.snapshot ?? options.reading?.snapshot ?? (options.ended ? options.retainedSnapshot : undefined)
  if (options.ended && !snapshot)
    return undefined
  if (options.historySupported) {
    if (snapshot) {
      const offset = options.history
        ? Math.max(0, options.history.offset - historyPageLimit)
        : options.reading?.offset ?? null
      return { type: 'History', snapshot, offset, limit: historyPageLimit }
    }
    if (!options.screen)
      return undefined
    return { type: 'History', snapshot: null, offset: null, limit: historyPageLimit }
  }
  if (!options.screen)
    return undefined
  const limit = Math.min(historyPageLimit, Math.floor(20_000 / options.screen.dimensions.cols))
  const offset = options.history
    ? Math.max(0, options.history.offset - limit)
    : options.reading?.offset ?? Math.max(0, options.screen.scrollbackLength - limit)
  return { type: 'Scrollback', offset, limit }
}
