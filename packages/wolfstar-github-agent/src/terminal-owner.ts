import type {
  TerminalClientMessage,
  TerminalInput,
  TerminalResult,
  TerminalScreen,
  TerminalServerMessage,
  TerminalSession,
  TerminalWriter,
} from './terminal-protocol.ts'

export interface TerminalEmulator {
  write: (bytes: Uint8Array | string) => void
  resize: (cols: number, rows: number) => void
  update: () => unknown
  getDimensions: () => { cols: number; rows: number }
  getLine: (row: number) => TerminalScreen['lines'][number] | null
  getViewport: () => TerminalScreen['lines'][number]
  getCursor: () => TerminalScreen['cursor']
  getGraphemeString: (row: number, col: number) => string
  isRowWrapped: (row: number) => boolean
  isAlternateScreen: () => boolean
  hasBracketedPaste: () => boolean
  hasFocusEvents: () => boolean
  hasMouseTracking: () => boolean
  getMode: (mode: number, isAnsi?: boolean) => boolean
  getKittyKeyboardFlags: () => number
  getScrollbackLength: () => number
  getScrollbackLine: (offset: number) => TerminalScreen['lines'][number] | null
  getScrollbackGraphemeString: (offset: number, col: number) => string
  hasResponse: () => boolean
  readResponse: () => string | null
  free: () => void
}
export interface TerminalKeyboardEncoder {
  encode: (event: Extract<TerminalInput, { type: 'Key' }>['event']) => Uint8Array
  dispose: () => void
}
export interface TerminalPty {
  write: (bytes: string) => void
  resize: (cols: number, rows: number) => void
}
export function createTerminalOwner(options: {
  session: TerminalSession
  emulator: TerminalEmulator
  encoder: TerminalKeyboardEncoder
  encodeText: (text: string) => Uint8Array
  pty: TerminalPty
  now: () => number
  token: () => string
  historyLimit?: number
}) {
  const { emulator, encoder, pty } = options
  const attachments = new Map<string, { send: (message: TerminalServerMessage) => void; revision: number }>()
  let writer: TerminalWriter = null
  let sequence = 0
  let revision = 1
  let previousScreen: TerminalScreen | null = null
  let ended = false
  const historyLimit = options.historyLimit ?? 1000
  function broadcast(message: TerminalServerMessage) {
    for (const attachment of attachments.values()) attachment.send(message)
  }
  function expire() {
    if (writer && writer.expiresAt <= options.now()) {
      writer = null
      broadcast({ type: 'WriterChanged', writer: null })
    }
  }
  function snapshot(): TerminalScreen {
    emulator.update()
    const dimensions = emulator.getDimensions()
    const cursor = emulator.getCursor()
    const viewport = emulator.getViewport()
    const lines = Array.from({ length: dimensions.rows }, (_, row) =>
      viewport.slice(row * dimensions.cols, (row + 1) * dimensions.cols).map((cell) => ({ ...cell })),
    )
    return {
      revision,
      scrollbackLength: Math.min(historyLimit, emulator.getScrollbackLength()),
      dimensions,
      lines,
      cursor: { x: cursor.x, y: cursor.y, visible: Boolean(cursor.visible) },
      graphemes: lines.map((line, row) =>
        line.map((cell, col) =>
          cell.grapheme_len ? emulator.getGraphemeString(row, col) : String.fromCodePoint(cell.codepoint || 32),
        ),
      ),
      wrapped: lines.map((_, row) => emulator.isRowWrapped(row)),
      modes: {
        alternate: emulator.isAlternateScreen(),
        paste: emulator.hasBracketedPaste(),
        focus: emulator.hasFocusEvents(),
        mouse: emulator.hasMouseTracking(),
        keyboard: emulator.getKittyKeyboardFlags(),
      },
    }
  }
  function publish() {
    expire()
    const screen = snapshot()
    const previous = previousScreen
    const full =
      !previous ||
      previous.dimensions.cols !== screen.dimensions.cols ||
      previous.dimensions.rows !== screen.dimensions.rows ||
      previous.modes.alternate !== screen.modes.alternate
    const keys = [
      'codepoint',
      'fg_r',
      'fg_g',
      'fg_b',
      'bg_r',
      'bg_g',
      'bg_b',
      'flags',
      'width',
      'hyperlink_id',
      'grapheme_len',
    ] as const
    const rows = screen.lines.flatMap((cells, index) => {
      const changed =
        !previous ||
        previous.wrapped[index] !== screen.wrapped[index] ||
        cells.some((cell, col) => {
          const prior = previous.lines[index]?.[col]
          return (
            !prior ||
            screen.graphemes[index]?.[col] !== previous.graphemes[index]?.[col] ||
            keys.some((key) => cell[key] !== prior[key])
          )
        })
      return changed
        ? [
            {
              index,
              cells,
              graphemes: screen.graphemes[index] ?? [],
              wrapped: screen.wrapped[index] ?? false,
            },
          ]
        : []
    })
    for (const attachment of attachments.values()) {
      if (attachment.revision === screen.revision) continue
      if (full || !previous || attachment.revision !== previous.revision) {
        attachment.send({
          type: 'Screen',
          generation: options.session.generation,
          screen,
        })
      } else {
        attachment.send({
          type: 'Rows',
          generation: options.session.generation,
          baseRevision: previous.revision,
          revision: screen.revision,
          rows,
          cursor: screen.cursor,
          modes: screen.modes,
          scrollbackLength: screen.scrollbackLength,
        })
      }
      attachment.revision = screen.revision
    }
    previousScreen = screen
  }
  function authority(viewId: string, lease: string, nextSequence: number): TerminalResult<true> {
    expire()
    if (ended || !writer || writer.viewId !== viewId || writer.lease !== lease)
      return { _tag: 'Err', reason: 'StaleWriter' }
    if (nextSequence <= sequence) return { _tag: 'Err', reason: 'DuplicateInput' }
    if (nextSequence !== sequence + 1) return { _tag: 'Err', reason: 'DeliveryUnknown' }
    sequence = nextSequence
    writer.expiresAt = options.now() + 30000
    return { _tag: 'Ok', value: true }
  }
  function inputBytes(input: TerminalInput): string {
    if (input.type === 'Paste') {
      return emulator.hasBracketedPaste() ? `\x1B[200~${input.text}\x1B[201~` : input.text
    }
    if (input.type === 'Text') return Buffer.from(options.encodeText(input.text)).toString('utf8')
    if (input.type === 'Key') {
      return Buffer.from(encoder.encode(input.event)).toString('utf8')
    }
    if (input.type === 'Focus') {
      return emulator.hasFocusEvents() ? (input.focused ? '\x1B[I' : '\x1B[O') : ''
    }
    if (!emulator.hasMouseTracking()) return ''
    if (input.action === 'move' && !emulator.getMode(1003) && !(emulator.getMode(1002) && input.button !== 3)) {
      return ''
    }
    const dimensions = emulator.getDimensions()
    if (input.col > dimensions.cols || input.row > dimensions.rows) return ''
    let button = input.button | (input.mods & 1 ? 4 : 0) | (input.mods & 2 ? 8 : 0) | (input.mods & 4 ? 16 : 0)
    if (input.action === 'move') button |= 32
    if (emulator.getMode(1006)) return `\x1B[<${button};${input.col};${input.row}${input.action === 'up' ? 'm' : 'M'}`
    if (input.action === 'up') button = 3
    if (emulator.getMode(1015)) return `\x1B[${button + 32};${input.col};${input.row}M`
    if (emulator.getMode(1005)) return `\x1B[M${String.fromCodePoint(button + 32, input.col + 32, input.row + 32)}`
    if (input.col > 223 || input.row > 223) return ''
    return `\x1B[M${String.fromCharCode(button + 32, input.col + 32, input.row + 32)}`
  }
  return {
    snapshot,
    get revision() {
      return revision
    },
    get writer() {
      expire()
      return writer ? { ...writer } : null
    },
    output(bytes: string | Uint8Array) {
      emulator.write(bytes)
      revision++
      while (emulator.hasResponse()) {
        const response = emulator.readResponse()
        if (!response) break
        pty.write(response)
      }
    },
    publish,
    attach(viewId: string, generation: string, send: (message: TerminalServerMessage) => void): TerminalResult<true> {
      if (generation !== options.session.generation) return { _tag: 'Err', reason: 'StaleGeneration' }
      if (attachments.has(viewId)) return { _tag: 'Err', reason: 'InvalidRequest' }
      attachments.set(viewId, { send, revision })
      send({
        type: 'Attached',
        protocol: 1,
        session: options.session,
        writer: writer ? { ...writer } : null,
      })
      send({ type: 'Screen', generation, screen: snapshot() })
      return { _tag: 'Ok', value: true }
    },
    detach(viewId: string) {
      attachments.delete(viewId)
      if (writer?.viewId === viewId) {
        writer = null
        broadcast({ type: 'WriterChanged', writer: null })
      }
    },
    message(viewId: string, message: Exclude<TerminalClientMessage, { type: 'Attach' }>): TerminalResult<true> {
      if (!attachments.has(viewId)) return { _tag: 'Err', reason: 'SessionUnavailable' }
      expire()
      if (message.type === 'RenewWriter') {
        if (!writer || writer.viewId !== viewId || writer.lease !== message.lease) {
          return { _tag: 'Err', reason: 'StaleWriter' }
        }
        writer.expiresAt = options.now() + 30000
        attachments.get(viewId)?.send({
          type: 'WriterChanged',
          writer: { ...writer },
        })
        return { _tag: 'Ok', value: true }
      }
      if (message.type === 'Scrollback') {
        const nativeTotal = emulator.getScrollbackLength()
        const total = Math.min(historyLimit, nativeTotal)
        const nativeStart = nativeTotal - total
        const offset = Math.min(message.offset, total)
        const lines = Array.from(
          {
            length: Math.min(message.limit, total - offset, Math.floor(20000 / emulator.getDimensions().cols)),
          },
          (_, row) =>
            (emulator.getScrollbackLine(nativeStart + offset + row) ?? []).map((cell) => ({
              ...cell,
            })),
        )
        const graphemes = lines.map((line, row) =>
          line.map((cell, col) =>
            cell.grapheme_len
              ? emulator.getScrollbackGraphemeString(nativeStart + offset + row, col)
              : String.fromCodePoint(cell.codepoint || 32),
          ),
        )
        attachments.get(viewId)?.send({
          type: 'Scrollback',
          generation: options.session.generation,
          total,
          offset,
          lines,
          graphemes,
        })
        return { _tag: 'Ok', value: true }
      }
      if (message.type === 'AcquireWriter') {
        if (ended) return { _tag: 'Err', reason: 'SessionUnavailable' }
        if (writer && writer.viewId !== viewId) return { _tag: 'Err', reason: 'WriterBusy' }
        if (writer) {
          writer.expiresAt = options.now() + 30000
        } else {
          writer = {
            viewId,
            lease: options.token(),
            expiresAt: options.now() + 30000,
          }
          sequence = 0
        }
        broadcast({ type: 'WriterChanged', writer: { ...writer } })
        return { _tag: 'Ok', value: true }
      }
      if (message.type === 'ReleaseWriter') {
        if (writer?.viewId === viewId) {
          writer = null
          broadcast({ type: 'WriterChanged', writer: null })
        }
        return { _tag: 'Ok', value: true }
      }
      const permitted = authority(viewId, message.lease, message.sequence)
      if (permitted._tag === 'Err') return permitted
      if (message.type === 'Resize') {
        emulator.resize(message.cols, message.rows)
        pty.resize(message.cols, message.rows)
        revision++
        publish()
      } else {
        const bytes = inputBytes(message)
        if (bytes) pty.write(bytes)
      }
      attachments.get(viewId)?.send({
        type: 'InputReceipt',
        sequence: message.sequence,
        lease: message.lease,
      })
      return { _tag: 'Ok', value: true }
    },
    exited() {
      publish()
      ended = true
      writer = null
      broadcast({ type: 'WriterChanged', writer: null })
      broadcast({ type: 'Process', state: 'Stopping' })
    },
    dispose() {
      attachments.clear()
      emulator.free()
      encoder.dispose()
    },
  }
}
