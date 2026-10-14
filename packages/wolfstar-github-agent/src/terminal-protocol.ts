export const TERMINAL_PROTOCOL = 1 as const
export type TerminalProvider = 'codex' | 'claude' | 'opencode'
export interface TerminalProject {
  id: string
  name: string
  path: string
}
export type TerminalState = 'Starting' | 'Running' | 'Stopping' | 'Exited' | 'Interrupted' | 'Unknown'
export interface TerminalSession {
  id: string
  generation: string
  projectId: string
  provider: TerminalProvider
  hostId: string
  bootId: string
  state: TerminalState
  createdAt: string
  worktree: string | null
}
export interface TerminalLaunch {
  requestId: string
  projectId: string
  provider: TerminalProvider
}
export interface TerminalCell {
  codepoint: number
  fg_r: number
  fg_g: number
  fg_b: number
  bg_r: number
  bg_g: number
  bg_b: number
  flags: number
  width: number
  hyperlink_id: number
  grapheme_len: number
}
export interface TerminalScreen {
  revision: number
  scrollbackLength: number
  dimensions: { cols: number; rows: number }
  cursor: { x: number; y: number; visible: boolean }
  lines: TerminalCell[][]
  graphemes: string[][]
  wrapped: boolean[]
  modes: {
    alternate: boolean
    paste: boolean
    focus: boolean
    mouse: boolean
    keyboard: number
  }
}
export type TerminalInput =
  | {
      type: 'Key'
      event: {
        action: 0 | 1 | 2
        key: number
        mods: number
        consumedMods?: number
        composing?: boolean
        utf8?: string
        unshiftedCodepoint?: number
      }
    }
  | { type: 'Text'; text: string }
  | { type: 'Paste'; text: string }
  | { type: 'Focus'; focused: boolean }
  | {
      type: 'Mouse'
      action: 'down' | 'up' | 'move' | 'wheel'
      button: 0 | 1 | 2 | 3 | 64 | 65
      col: number
      row: number
      mods: number
    }
export type TerminalWriter = {
  viewId: string
  lease: string
  expiresAt: number
} | null
export type TerminalClientMessage =
  | { type: 'Attach'; protocol: 1; viewId: string; generation: string }
  | { type: 'AcquireWriter' }
  | { type: 'ReleaseWriter' }
  | { type: 'RenewWriter'; lease: string }
  | { type: 'Scrollback'; offset: number; limit: number }
  | {
      type: 'Resize'
      lease: string
      sequence: number
      cols: number
      rows: number
    }
  | ({ lease: string; sequence: number } & TerminalInput)
export type TerminalFailure =
  | 'InvalidRequest'
  | 'AuthenticationRequired'
  | 'OriginRefused'
  | 'ProtocolMismatch'
  | 'StaleGeneration'
  | 'WriterBusy'
  | 'StaleWriter'
  | 'DuplicateInput'
  | 'SizeLimit'
  | 'ProviderUnavailable'
  | 'ProjectUnavailable'
  | 'CapacityUnavailable'
  | 'CapacityRefused'
  | 'LaunchConflict'
  | 'OwnershipUnknown'
  | 'SessionUnavailable'
  | 'DeliveryUnknown'
export interface TerminalRows {
  generation: string
  baseRevision: number
  revision: number
  rows: {
    index: number
    cells: TerminalCell[]
    graphemes: string[]
    wrapped: boolean
  }[]
  cursor: TerminalScreen['cursor']
  modes: TerminalScreen['modes']
  scrollbackLength: number
}
export type TerminalServerMessage =
  | {
      type: 'Attached'
      protocol: 1
      session: TerminalSession
      writer: TerminalWriter
    }
  | { type: 'Screen'; generation: string; screen: TerminalScreen }
  | ({ type: 'Rows' } & TerminalRows)
  | {
      type: 'Scrollback'
      generation: string
      total: number
      offset: number
      lines: TerminalCell[][]
      graphemes: string[][]
    }
  | { type: 'WriterChanged'; writer: TerminalWriter }
  | { type: 'InputReceipt'; sequence: number; lease: string }
  | { type: 'Process'; state: TerminalState }
  | { type: 'Failure'; reason: TerminalFailure }
export type TerminalResult<T> = { _tag: 'Ok'; value: T } | { _tag: 'Err'; reason: TerminalFailure }
export interface TerminalCapabilities {
  protocol: 1
  hostId: string
  bootId: string
  hostLabel: string
  controller: boolean
  controllerReadOnly: boolean
  providers: Record<TerminalProvider, boolean>
  supports: {
    terminal: true
    stop: true
    writer: true
    resize: true
    mouse: true
    focus: true
  }
}
export type TerminalCapacity =
  | {
      _tag: 'Available'
      agentSlots: number
      maintenanceReserve: number
      interactiveFree: number
      memoryGiB: number
      reservedGiB: number
    }
  | { _tag: 'Unavailable' }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0')
}
function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
}
export function parseTerminalJson(input: string): TerminalResult<unknown> {
  try {
    return { _tag: 'Ok', value: JSON.parse(input) }
  } catch (cause) {
    if (cause instanceof SyntaxError) return { _tag: 'Err', reason: 'InvalidRequest' }
    throw cause
  }
}
export function parseTerminalLaunch(value: unknown): TerminalResult<TerminalLaunch> {
  if (
    !record(value) ||
    !text(value.requestId, 128) ||
    !text(value.projectId, 128) ||
    typeof value.provider !== 'string' ||
    !['codex', 'claude', 'opencode'].includes(value.provider)
  ) {
    return { _tag: 'Err', reason: 'InvalidRequest' }
  }
  return {
    _tag: 'Ok',
    value: {
      requestId: value.requestId,
      projectId: value.projectId,
      provider: value.provider as TerminalProvider,
    },
  }
}
export function parseTerminalClientMessage(value: unknown): TerminalResult<TerminalClientMessage> {
  if (!record(value)) return { _tag: 'Err', reason: 'InvalidRequest' }
  if (value.type === 'Attach') {
    if (value.protocol !== TERMINAL_PROTOCOL) return { _tag: 'Err', reason: 'ProtocolMismatch' }
    if (!text(value.viewId, 128) || !text(value.generation, 128)) return { _tag: 'Err', reason: 'InvalidRequest' }
    return {
      _tag: 'Ok',
      value: {
        type: 'Attach',
        protocol: 1,
        viewId: value.viewId,
        generation: value.generation,
      },
    }
  }
  if (value.type === 'AcquireWriter' || value.type === 'ReleaseWriter')
    return { _tag: 'Ok', value: { type: value.type } }
  if (value.type === 'RenewWriter' && text(value.lease, 128))
    return { _tag: 'Ok', value: { type: 'RenewWriter', lease: value.lease } }
  if (value.type === 'Scrollback' && integer(value.offset, 0, 1000) && integer(value.limit, 1, 200)) {
    return {
      _tag: 'Ok',
      value: { type: 'Scrollback', offset: value.offset, limit: value.limit },
    }
  }
  if (!text(value.lease, 128) || !integer(value.sequence, 1, Number.MAX_SAFE_INTEGER)) {
    return { _tag: 'Err', reason: 'InvalidRequest' }
  }
  const authority = { lease: value.lease, sequence: value.sequence }
  if (value.type === 'Resize') {
    if (!integer(value.cols, 2, 500) || !integer(value.rows, 2, 200) || value.cols * value.rows > 20000) {
      return { _tag: 'Err', reason: 'SizeLimit' }
    }
    return {
      _tag: 'Ok',
      value: {
        type: 'Resize',
        ...authority,
        cols: value.cols,
        rows: value.rows,
      },
    }
  }
  if (value.type === 'Text' || value.type === 'Paste') {
    if (typeof value.text !== 'string' || value.text.includes('\0') || Buffer.byteLength(value.text) > 65536) {
      return { _tag: 'Err', reason: 'SizeLimit' }
    }
    return {
      _tag: 'Ok',
      value: { type: value.type, ...authority, text: value.text },
    }
  }
  if (value.type === 'Focus' && typeof value.focused === 'boolean') {
    return {
      _tag: 'Ok',
      value: { type: 'Focus', ...authority, focused: value.focused },
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
      (event.utf8 !== undefined &&
        (typeof event.utf8 !== 'string' || Buffer.byteLength(event.utf8) > 128 || event.utf8.includes('\0')))
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
    return { _tag: 'Ok', value: { type: 'Key', ...authority, event: parsed } }
  }
  if (
    value.type === 'Mouse' &&
    typeof value.action === 'string' &&
    ['down', 'up', 'move', 'wheel'].includes(value.action) &&
    integer(value.button, 0, 65) &&
    [0, 1, 2, 3, 64, 65].includes(value.button) &&
    integer(value.col, 1, 500) &&
    integer(value.row, 1, 200) &&
    integer(value.mods, 0, 7)
  ) {
    return {
      _tag: 'Ok',
      value: {
        type: 'Mouse',
        ...authority,
        action: value.action as 'down' | 'up' | 'move' | 'wheel',
        button: value.button as 0 | 1 | 2 | 3 | 64 | 65,
        col: value.col,
        row: value.row,
        mods: value.mods,
      },
    }
  }
  return { _tag: 'Err', reason: 'InvalidRequest' }
}
