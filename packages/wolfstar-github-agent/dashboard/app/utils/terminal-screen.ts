import type { TerminalResult, TerminalScreen, TerminalServerMessage } from '../../../src/terminal-protocol.ts'

type ScreenMessage = Extract<TerminalServerMessage, { type: 'Screen' | 'Rows' }>

/** Apply parsed frames atomically. Refused deltas require a fresh snapshot. */
export function applyTerminalScreen(
  current: TerminalScreen | undefined,
  message: ScreenMessage,
  generation: string,
): TerminalResult<TerminalScreen> {
  if (message.generation !== generation) return { _tag: 'Err', reason: 'StaleGeneration' }
  if (message.type === 'Screen') return { _tag: 'Ok', value: message.screen }
  if (!current || message.baseRevision !== current.revision) return { _tag: 'Err', reason: 'DeliveryUnknown' }
  const { cols, rows } = current.dimensions
  if (
    message.cursor.x >= cols ||
    message.cursor.y >= rows ||
    message.rows.some((row) => row.index >= rows || row.cells.length !== cols || row.graphemes.length !== cols)
  ) {
    return { _tag: 'Err', reason: 'InvalidRequest' }
  }
  const lines = [...current.lines]
  const graphemes = [...current.graphemes]
  const wrapped = [...current.wrapped]
  for (const row of message.rows) {
    lines[row.index] = row.cells
    graphemes[row.index] = row.graphemes
    wrapped[row.index] = row.wrapped
  }
  return {
    _tag: 'Ok',
    value: {
      ...current,
      revision: message.revision,
      lines,
      graphemes,
      wrapped,
      cursor: message.cursor,
      modes: message.modes,
      scrollbackLength: message.scrollbackLength,
    },
  }
}
