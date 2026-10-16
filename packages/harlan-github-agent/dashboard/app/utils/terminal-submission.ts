import type { TerminalInput, TerminalResult } from '../../../src/terminal-protocol.ts'

export type TerminalSubmission
  = | { _tag: 'Editing' }
    | { _tag: 'Pending', phase: 'Paste' | 'Enter', text: string, enter: TerminalInput, lease: string, sequence: number }
    | { _tag: 'Pasted', text: string, enter: TerminalInput }
    | { _tag: 'Unknown' | 'Acknowledged', text: string }

/** A socket write is not an acknowledgment. Retain the draft through both receipts. */
export function beginTerminalSubmission(text: string, enter: TerminalInput, lease: string, result: TerminalResult<number>, pasted = false): TerminalSubmission {
  if (result._tag === 'Err') {
    if (result.reason === 'DeliveryUnknown')
      return { _tag: 'Unknown', text }
    return pasted ? { _tag: 'Pasted', text, enter } : { _tag: 'Editing' }
  }
  return { _tag: 'Pending', phase: text && !pasted ? 'Paste' : 'Enter', text, enter, lease, sequence: result.value }
}

export function advanceTerminalSubmission(state: TerminalSubmission, sequence: number, lease: string): { state: TerminalSubmission, send?: TerminalInput } {
  if (state._tag !== 'Pending' || state.sequence !== sequence || state.lease !== lease)
    return { state }
  return state.phase === 'Paste'
    ? { state: { _tag: 'Pasted', text: state.text, enter: state.enter }, send: state.enter }
    : { state: { _tag: 'Acknowledged', text: state.text } }
}

/** Disconnects and timeouts never replay terminal input. The person checks the screen. */
export function interruptTerminalSubmission(state: TerminalSubmission): TerminalSubmission {
  return state._tag === 'Pending' ? { _tag: 'Unknown', text: state.text } : state
}
