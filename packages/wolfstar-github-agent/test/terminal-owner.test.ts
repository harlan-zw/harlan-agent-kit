import type { KeyEvent } from 'ghostty-terminal-bindings'
import type { TerminalServerMessage, TerminalSession } from '../src/terminal.ts'
import { readFile } from 'node:fs/promises'
import { createGhostty, encodeKey, encodeTextCommit, wasmPath } from 'ghostty-terminal-bindings'
import { describe, expect, it } from 'vitest'
import { createTerminalOwner } from '../src/terminal.ts'

const session: TerminalSession = {
  id: 'session',
  generation: 'generation',
  projectId: 'project',
  provider: 'codex',
  hostId: 'host',
  bootId: 'boot',
  state: 'Running',
  createdAt: '2026-10-12T00:00:00Z',
  worktree: '/scratch/worktree',
}
async function fixture() {
  const ghostty = await createGhostty(await readFile(wasmPath()), (message) => {
    throw new Error(message)
  })
  const terminal = ghostty.createTerminal(20, 5, { scrollbackLimit: 10 })
  const encoder = ghostty.createKeyEncoder()
  const writes: string[] = []
  const sizes: { cols: number; rows: number }[] = []
  let now = 0
  let token = 0
  const owner = createTerminalOwner({
    session,
    emulator: terminal,
    encoder: {
      encode: (event) => encodeKey(terminal, encoder, event as KeyEvent),
      dispose: () => encoder.dispose(),
    },
    encodeText: (text) => encodeTextCommit(terminal, encoder, text),
    pty: {
      write: (bytes) => writes.push(bytes),
      resize: (cols, rows) => sizes.push({ cols, rows }),
    },
    now: () => now,
    token: () => `writer-${++token}`,
    historyLimit: 10,
  })
  const messages: TerminalServerMessage[] = []
  owner.attach('one', 'generation', (message) => messages.push(message))
  owner.message('one', { type: 'AcquireWriter' })
  const lease = owner.writer!.lease
  return {
    owner,
    writes,
    sizes,
    messages,
    lease,
    advance: (milliseconds: number) => {
      now += milliseconds
    },
  }
}
describe('canonical terminal owner', () => {
  it('sends only changed rows after each viewer receives a full screen', async () => {
    const { owner, messages } = await fixture()
    owner.output('first')
    owner.publish()
    const afterFirst = messages.at(-1)
    expect(afterFirst?.type).toBe('Screen')
    owner.output('\x1B[2;1Hsecond')
    owner.publish()
    const delta = messages.at(-1)
    expect(delta?.type).toBe('Rows')
    if (delta?.type !== 'Rows' || afterFirst?.type !== 'Screen') throw new Error('No row delta')
    expect(delta.baseRevision).toBe(afterFirst.screen.revision)
    expect(delta.rows.map((row) => row.index)).toEqual([1])
    expect(delta.rows[0]?.graphemes.join('')).toContain('second')
    const count = messages.length
    owner.publish()
    expect(messages.length).toBe(count)
    owner.dispose()
  })
  it('answers detached terminal queries once without a viewer or second parser', async () => {
    const { owner, writes } = await fixture()
    owner.detach('one')
    owner.output('\x1B[6n\x1B[>1u\x1B[?u')
    expect(writes.join('')).toBe('\x1B[1;1R\x1B[?1u')
    owner.dispose()
  })
  it('encodes negotiated keyboard modes at the host boundary', async () => {
    const { owner, writes, lease } = await fixture()
    owner.output('\x1B[>31u')
    expect(
      owner.message('one', {
        type: 'Key',
        lease,
        sequence: 1,
        event: { key: 58, action: 1, mods: 1 },
      }),
    ).toEqual({ _tag: 'Ok', value: true })
    expect(writes.at(-1)).toBe('\x1B[13;2u')
    owner.message('one', { type: 'Text', lease, sequence: 2, text: '中👩‍💻' })
    expect(writes.at(-1)).toBe('中👩‍💻')
    owner.dispose()
  })
  it('fences readers, stale writers, sequence gaps, and duplicate input', async () => {
    const { owner, writes, lease } = await fixture()
    owner.attach('two', 'generation', () => {})
    expect(owner.message('two', { type: 'AcquireWriter' })).toEqual({
      _tag: 'Err',
      reason: 'WriterBusy',
    })
    expect(owner.message('two', { type: 'Text', lease, sequence: 1, text: 'bad' })).toEqual({
      _tag: 'Err',
      reason: 'StaleWriter',
    })
    expect(owner.message('one', { type: 'Text', lease, sequence: 2, text: 'bad' })).toEqual({
      _tag: 'Err',
      reason: 'DeliveryUnknown',
    })
    owner.message('one', { type: 'Text', lease, sequence: 1, text: 'once' })
    expect(owner.message('one', { type: 'Text', lease, sequence: 1, text: 'twice' })).toEqual({
      _tag: 'Err',
      reason: 'DuplicateInput',
    })
    owner.detach('one')
    owner.message('two', { type: 'AcquireWriter' })
    expect(owner.message('two', { type: 'Text', lease, sequence: 1, text: 'stale' })).toEqual({
      _tag: 'Err',
      reason: 'StaleWriter',
    })
    expect(writes).toEqual(['once'])
    owner.dispose()
  })
  it('renews a current writer without extending an expired writer', async () => {
    const { owner, lease, advance } = await fixture()
    advance(15000)
    expect(owner.message('one', { type: 'RenewWriter', lease })).toEqual({
      _tag: 'Ok',
      value: true,
    })
    advance(30001)
    expect(owner.message('one', { type: 'RenewWriter', lease })).toEqual({
      _tag: 'Err',
      reason: 'StaleWriter',
    })
    expect(owner.writer).toBeNull()
    owner.dispose()
  })
  it('preserves native paste, focus, SGR mouse, resize and immutable grapheme screens', async () => {
    const { owner, writes, sizes, lease } = await fixture()
    owner.output('\x1B[?2004h\x1B[?1004h\x1B[?1000h\x1B[?1006h中👩‍💻')
    const screen = owner.snapshot()
    expect(typeof screen.cursor.visible).toBe('boolean')
    owner.message('one', {
      type: 'Paste',
      lease,
      sequence: 1,
      text: 'line\nline',
    })
    owner.message('one', { type: 'Focus', lease, sequence: 2, focused: true })
    owner.message('one', {
      type: 'Mouse',
      lease,
      sequence: 3,
      action: 'down',
      button: 0,
      col: 2,
      row: 3,
      mods: 0,
    })
    owner.message('one', {
      type: 'Resize',
      lease,
      sequence: 4,
      cols: 30,
      rows: 6,
    })
    expect(writes).toEqual(['\x1B[200~line\nline\x1B[201~', '\x1B[I', '\x1B[<0;2;3M'])
    expect(sizes).toEqual([{ cols: 30, rows: 6 }])
    expect(screen.dimensions).toEqual({ cols: 20, rows: 5 })
    expect(screen.graphemes.flat().join('')).toContain('👩‍💻')
    owner.dispose()
  })
  it('allows an observer to page bounded native scrollback without owning input', async () => {
    const { owner } = await fixture()
    const messages: TerminalServerMessage[] = []
    owner.attach('reader', 'generation', (message) => messages.push(message))
    owner.output(Array.from({ length: 20 }, (_, index) => `line-${index}\r\n`).join(''))
    expect(owner.message('reader', { type: 'Scrollback', offset: 0, limit: 200 })).toEqual({ _tag: 'Ok', value: true })
    const history = messages.at(-1)
    expect(history?.type).toBe('Scrollback')
    if (history?.type !== 'Scrollback') throw new Error('No history')
    expect(history.lines.length).toBeLessThanOrEqual(10)
    expect(history.graphemes.map((line) => line.join('')).join('\n')).toContain('line-')
    owner.dispose()
  })
})
