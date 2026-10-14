import type { TerminalInput } from '../../../src/terminal-protocol.ts'

/** Keep native phone edits local. Send the final text as one bracketed paste. */
export function submitTerminalDraft(text: string, enter: TerminalInput, transmit: (input: TerminalInput) => boolean): 'Rejected' | 'Pasted' | 'Submitted' {
  if (text && !transmit({ type: 'Paste', text }))
    return 'Rejected'
  return transmit(enter) ? 'Submitted' : text ? 'Pasted' : 'Rejected'
}
