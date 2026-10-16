export interface TerminalHistoryMemory {
  reading: { snapshot?: string, offset: number, top: number } | null
  retainedSnapshot: string | null
}

/** Captures the archive identity separately from the history view. */
export function terminalHistoryAfterPage(memory: TerminalHistoryMemory, snapshot: string | undefined): TerminalHistoryMemory {
  return { ...memory, retainedSnapshot: snapshot ?? memory.retainedSnapshot }
}

/** Latest replaces the view but leaves its unexpired archive recoverable. */
export function terminalHistoryAfterLatest(memory: TerminalHistoryMemory): TerminalHistoryMemory {
  return { ...memory, reading: null }
}

export function terminalHistoryAfterExpiry(memory: TerminalHistoryMemory): TerminalHistoryMemory {
  return { ...memory, retainedSnapshot: null }
}
