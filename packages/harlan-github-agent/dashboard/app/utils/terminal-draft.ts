import type { TerminalInput, TerminalSession } from '../../../src/terminal-protocol.ts'
import { computed, reactive } from 'vue'

/** Workspace ownership preserves drafts when a terminal tab unmounts. */
export function createTerminalDraftStore() {
  const drafts = reactive(new Map<string, string>())
  function forSession(session: Pick<TerminalSession, 'id' | 'generation'>) {
    const key = JSON.stringify([session.id, session.generation])
    return computed({
      get: () => drafts.get(key) ?? '',
      set: (text: string) => {
        if (text)
          drafts.set(key, text)
        else
          drafts.delete(key)
      },
    })
  }
  return { forSession }
}

/** Keep native phone edits local. Send the final text as one bracketed paste. */
export function submitTerminalDraft(text: string, enter: TerminalInput, transmit: (input: TerminalInput) => boolean): 'Rejected' | 'Pasted' | 'Submitted' {
  if (text && !transmit({ type: 'Paste', text }))
    return 'Rejected'
  return transmit(enter) ? 'Submitted' : text ? 'Pasted' : 'Rejected'
}
