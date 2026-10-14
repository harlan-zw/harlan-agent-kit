import type {
  TerminalClientMessage,
  TerminalInput,
  TerminalResult,
  TerminalWriter,
} from '../../../src/terminal-protocol.ts'

export interface TerminalResizeInput {
  type: 'Resize'
  cols: number
  rows: number
}
type Input = TerminalInput | TerminalResizeInput
interface WriterEpoch {
  writer: NonNullable<TerminalWriter>
  sequence: number
  pending: Set<number>
}
type ChannelState = { _tag: 'Observer' } | ({ _tag: 'Ready' | 'Uncertain' | 'Detached' } & WriterEpoch)
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
function bytes(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length <= max &&
    !value.includes('\0') &&
    new TextEncoder().encode(value).byteLength <= max
  )
}
function parseInput(value: unknown): TerminalResult<Input> {
  if (!record(value)) return { _tag: 'Err', reason: 'InvalidRequest' }
  if (value.type === 'Text' || value.type === 'Paste') {
    if (!bytes(value.text, 65536)) return { _tag: 'Err', reason: 'SizeLimit' }
    return { _tag: 'Ok', value: { type: value.type, text: value.text } }
  }
  if (value.type === 'Resize') {
    if (!integer(value.cols, 2, 500) || !integer(value.rows, 2, 200) || value.cols * value.rows > 20_000)
      return { _tag: 'Err', reason: 'SizeLimit' }
    return { _tag: 'Ok', value: { type: 'Resize', cols: value.cols, rows: value.rows } }
  }
  if (value.type === 'Focus' && typeof value.focused === 'boolean')
    return { _tag: 'Ok', value: { type: 'Focus', focused: value.focused } }
  if (
    value.type === 'Mouse' &&
    typeof value.action === 'string' &&
    ['down', 'up', 'move', 'wheel'].includes(value.action) &&
    typeof value.button === 'number' &&
    [0, 1, 2, 3, 64, 65].includes(value.button) &&
    integer(value.col, 1, 500) &&
    integer(value.row, 1, 200) &&
    integer(value.mods, 0, 7)
  ) {
    return {
      _tag: 'Ok',
      value: {
        type: 'Mouse',
        action: value.action as Extract<TerminalInput, { type: 'Mouse' }>['action'],
        button: value.button as Extract<TerminalInput, { type: 'Mouse' }>['button'],
        col: value.col,
        row: value.row,
        mods: value.mods,
      },
    }
  }
  if (value.type === 'Key' && record(value.event)) {
    const event = value.event
    if (
      !integer(event.action, 0, 2) ||
      !integer(event.key, 0, 174) ||
      !integer(event.mods, 0, 63) ||
      (event.consumedMods !== undefined && !integer(event.consumedMods, 0, 63)) ||
      (event.composing !== undefined && typeof event.composing !== 'boolean') ||
      (event.unshiftedCodepoint !== undefined && !integer(event.unshiftedCodepoint, 0, 0x10ffff)) ||
      (event.utf8 !== undefined && !bytes(event.utf8, 128))
    ) {
      return { _tag: 'Err', reason: 'InvalidRequest' }
    }
    const parsed: Extract<TerminalInput, { type: 'Key' }>['event'] = {
      action: event.action as 0 | 1 | 2,
      key: event.key,
      mods: event.mods,
    }
    if (event.consumedMods !== undefined) parsed.consumedMods = event.consumedMods as number
    if (event.composing !== undefined) parsed.composing = event.composing as boolean
    if (event.unshiftedCodepoint !== undefined) parsed.unshiftedCodepoint = event.unshiftedCodepoint as number
    if (event.utf8 !== undefined) parsed.utf8 = event.utf8 as string
    return { _tag: 'Ok', value: { type: 'Key', event: parsed } }
  }
  return { _tag: 'Err', reason: 'InvalidRequest' }
}

/** False means the transport refused before writing. A thrown send has unknown delivery. */
export function createTerminalInputChannel(options: {
  send: (message: TerminalClientMessage) => boolean
  viewId: string
}) {
  let state: ChannelState = { _tag: 'Observer' }
  let unconfirmed = false
  return {
    setWriter(writer: TerminalWriter): void {
      if (
        writer &&
        writer.viewId === options.viewId &&
        state._tag !== 'Observer' &&
        state.writer.lease === writer.lease
      ) {
        state = {
          ...state,
          writer: { ...writer },
          _tag: state._tag === 'Detached' ? (state.pending.size > 0 ? 'Uncertain' : 'Ready') : state._tag,
        }
        return
      }
      if (state._tag !== 'Observer' && state.pending.size > 0) unconfirmed = true
      state =
        writer && writer.viewId === options.viewId
          ? { _tag: 'Ready', writer: { ...writer }, sequence: 0, pending: new Set() }
          : state._tag === 'Observer'
            ? state
            : { ...state, _tag: 'Detached' }
    },
    transmit(input: Input): TerminalResult<number> {
      if (state._tag === 'Observer' || state._tag === 'Detached') return { _tag: 'Err', reason: 'StaleWriter' }
      if (state._tag === 'Uncertain') return { _tag: 'Err', reason: 'DeliveryUnknown' }
      const parsed = parseInput(input)
      if (parsed._tag === 'Err') return parsed
      if (state.sequence >= Number.MAX_SAFE_INTEGER) return { _tag: 'Err', reason: 'SizeLimit' }
      const sequence = state.sequence + 1
      const message: TerminalClientMessage = { ...parsed.value, lease: state.writer.lease, sequence }
      try {
        if (!options.send(message)) return { _tag: 'Err', reason: 'SessionUnavailable' }
      } catch {
        // The transport may have written before throwing. Fence this lease and never replay it.
        state.sequence = sequence
        state.pending.add(sequence)
        state = { ...state, _tag: 'Uncertain' }
        return { _tag: 'Err', reason: 'DeliveryUnknown' }
      }
      state.sequence = sequence
      state.pending.add(sequence)
      return { _tag: 'Ok', value: sequence }
    },
    /** A lease is required to distinguish repeated sequence numbers across writer epochs. */
    receipt(sequence: number, lease: string): boolean {
      return (
        state._tag !== 'Observer' &&
        state._tag !== 'Detached' &&
        lease === state.writer.lease &&
        state.pending.delete(sequence)
      )
    },
    detach(): { unconfirmed: boolean } {
      unconfirmed ||= state._tag !== 'Observer' && state.pending.size > 0
      if (state._tag !== 'Observer') state = { ...state, _tag: 'Detached' }
      return { unconfirmed }
    },
  }
}
