import type { TerminalSession } from '../../../src/terminal-protocol.ts'
import { computed, reactive } from 'vue'

/** Workspace ownership preserves drafts when a terminal tab unmounts. */
export function createTerminalDraftStore(drafts = reactive(new Map<string, string>())) {
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
