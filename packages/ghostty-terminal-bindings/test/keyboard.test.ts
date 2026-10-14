import type { BrowserKeyboardEvent } from 'ghostty-terminal-bindings/browser'
import { readFileSync } from 'node:fs'
import { createGhostty, encodeKey, encodeTextCommit, Key, KeyAction, Mods, wasmPath } from 'ghostty-terminal-bindings'
import { browserKeyEvent } from 'ghostty-terminal-bindings/browser'
import { describe, expect, it } from 'vitest'

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

async function fixture() {
  const ghostty = await createGhostty(readFileSync(wasmPath()), (message) => {
    throw new Error(message)
  })
  const terminal = ghostty.createTerminal(80, 24)
  const encoder = ghostty.createKeyEncoder()
  return {
    terminal,
    encoder,
    dispose: () => {
      terminal.free()
      encoder.dispose()
    },
  }
}

function event(changes: Partial<BrowserKeyboardEvent> = {}): BrowserKeyboardEvent {
  return {
    code: 'KeyA',
    key: 'a',
    type: 'keydown',
    repeat: false,
    isComposing: false,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    getModifierState: () => false,
    ...changes,
  }
}

describe('native keyboard negotiation', () => {
  it.each([
    ['initial', '', 0],
    ['push', '\x1B[>1u', 1],
    ['pop', '\x1B[>1u\x1B[>3u\x1B[<u', 1],
    ['set', '\x1B[=31u', 31],
    ['OR', '\x1B[=1u\x1B[=2;2u', 3],
    ['NOT', '\x1B[=31u\x1B[=2;3u', 29],
    ['reset', '\x1B[>31u\x1Bc', 0],
  ])('answers the %s query from parsed state', async (_, sequence, expected) => {
    const owner = await fixture()
    try {
      if (sequence.length > 0) owner.terminal.write(sequence)
      owner.terminal.write('\x1B[?u')
      expect(owner.terminal.readResponse()).toBe(`\x1B[?${expected}u`)
      expect(owner.terminal.getKittyKeyboardFlags()).toBe(expected)
    } finally {
      owner.dispose()
    }
  })

  it('keeps separate screen stacks and handles fragmented sequences', async () => {
    const owner = await fixture()
    try {
      owner.terminal.write('\x1B[>')
      owner.terminal.write('1u\x1B[?1049h\x1B[>3u')
      expect(owner.terminal.getKittyKeyboardFlags()).toBe(3)
      owner.terminal.write('\x1B[?1049l\x1B[?u')
      expect(owner.terminal.readResponse()).toBe('\x1B[?1u')
    } finally {
      owner.dispose()
    }
  })

  it('changes modified Enter encoding after native negotiation and pop', async () => {
    const owner = await fixture()
    try {
      const input = browserKeyEvent(event({ code: 'Enter', key: 'Enter', shiftKey: true }))!
      const legacy = decode(encodeKey(owner.terminal, owner.encoder, input))
      owner.terminal.write('\x1B[>1u')
      expect(decode(encodeKey(owner.terminal, owner.encoder, input))).toBe('\x1B[13;2u')
      owner.terminal.write('\x1B[<u')
      expect(decode(encodeKey(owner.terminal, owner.encoder, input))).toBe(legacy)
    } finally {
      owner.dispose()
    }
  })

  it('uses native application cursor mode', async () => {
    const owner = await fixture()
    try {
      const input = browserKeyEvent(event({ code: 'ArrowUp', key: 'ArrowUp' }))!
      expect(decode(encodeKey(owner.terminal, owner.encoder, input))).toBe('\x1B[A')
      owner.terminal.write('\x1B[?1h')
      expect(decode(encodeKey(owner.terminal, owner.encoder, input))).toBe('\x1BOA')
    } finally {
      owner.dispose()
    }
  })

  it('uses native modify-other-keys mode and clears it when requested', async () => {
    const owner = await fixture()
    try {
      const input = browserKeyEvent(event({ code: 'KeyI', key: 'i', ctrlKey: true }))!
      expect(decode(encodeKey(owner.terminal, owner.encoder, input))).toBe('\x1B[105;5u')
      owner.terminal.write('\x1B[>4;2m')
      expect(decode(encodeKey(owner.terminal, owner.encoder, input))).toBe('\x1B[27;5;105~')
      owner.terminal.write('\x1B[>4;0m')
      expect(decode(encodeKey(owner.terminal, owner.encoder, input))).toBe('\x1B[105;5u')
    } finally {
      owner.dispose()
    }
  })

  it('encodes shifted punctuation through the supplied keyboard layout', async () => {
    const owner = await fixture()
    try {
      owner.terminal.write('\x1B[>9u')
      const input = browserKeyEvent(event({ code: 'Digit1', key: '!', shiftKey: true }), new Map([['Digit1', '1']]))!
      expect(decode(encodeKey(owner.terminal, owner.encoder, input))).toBe('\x1B[49;2u')
    } finally {
      owner.dispose()
    }
  })

  it('encodes printable text and events under report-all', async () => {
    const owner = await fixture()
    try {
      owner.terminal.write('\x1B[>11u')
      const pressed = browserKeyEvent(event())!
      const repeated = browserKeyEvent(event({ repeat: true }))!
      const released = browserKeyEvent(event({ type: 'keyup' }))!
      expect(decode(encodeKey(owner.terminal, owner.encoder, pressed))).toBe('\x1B[97u')
      expect(decode(encodeKey(owner.terminal, owner.encoder, repeated))).toBe('\x1B[97;1:2u')
      expect(decode(encodeKey(owner.terminal, owner.encoder, released))).toBe('\x1B[97;1:3u')
    } finally {
      owner.dispose()
    }
  })

  it('suppresses composition preview and encodes the native text commit', async () => {
    const owner = await fixture()
    try {
      owner.terminal.write('\x1B[>31u')
      expect(
        encodeKey(owner.terminal, owner.encoder, {
          action: KeyAction.PRESS,
          key: Key.A,
          mods: Mods.NONE,
          composing: true,
          utf8: 'a',
          unshiftedCodepoint: 97,
        }),
      ).toEqual(new Uint8Array())
      expect(decode(encodeTextCommit(owner.terminal, owner.encoder, '中文👩‍💻'))).toBe('中文👩‍💻')
      const longCommit = '中文👩‍💻'.repeat(100)
      expect(decode(encodeTextCommit(owner.terminal, owner.encoder, longCommit))).toBe(longCommit)
    } finally {
      owner.dispose()
    }
  })

  it('keeps consumed modifiers and Unicode codepoints through the native wrapper', async () => {
    const owner = await fixture()
    try {
      owner.terminal.write('\x1B[>1u')
      const typed = browserKeyEvent(event({ key: 'A', shiftKey: true }))!
      expect(decode(encodeKey(owner.terminal, owner.encoder, typed))).toBe('A')
      owner.terminal.write('\x1B[>9u')
      const unicode = browserKeyEvent(event({ code: 'Unidentified', key: '中' }))!
      expect(decode(encodeKey(owner.terminal, owner.encoder, unicode))).toBe('\x1B[20013u')
    } finally {
      owner.dispose()
    }
  })
})
