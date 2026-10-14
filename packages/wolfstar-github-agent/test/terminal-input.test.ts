import type { TerminalClientMessage, TerminalInput } from '../src/terminal-protocol.ts'
import { describe, expect, it } from 'vitest'
import { createTerminalInputChannel } from '../dashboard/app/utils/terminal-input.ts'

const key: TerminalInput = { type: 'Key', event: { action: 1, key: 1, mods: 0, utf8: 'a' } }
const writer = { viewId: 'view', lease: 'lease-a', expiresAt: 100 }
function setup(send?: (message: TerminalClientMessage) => boolean) {
  const messages: TerminalClientMessage[] = []
  const channel = createTerminalInputChannel({
    viewId: 'view',
    send:
      send ??
      ((message) => {
        messages.push(message)
        return true
      }),
  })
  channel.setWriter(writer)
  return { channel, messages }
}
describe('terminal input channel', () => {
  it('rejects oversized paste before allocating the first sequence', () => {
    const { channel, messages } = setup()
    expect(channel.transmit({ type: 'Paste', text: 'x'.repeat(65537) })).toEqual({ _tag: 'Err', reason: 'SizeLimit' })
    expect(channel.transmit(key)).toEqual({ _tag: 'Ok', value: 1 })
    expect(messages).toEqual([{ ...key, sequence: 1, lease: writer.lease }])
  })
  it('uses UTF8 byte counts and rejects embedded NUL', () => {
    const { channel, messages } = setup()
    expect(channel.transmit({ type: 'Text', text: '中'.repeat(21846) })).toEqual({ _tag: 'Err', reason: 'SizeLimit' })
    expect(channel.transmit({ type: 'Paste', text: 'x\0y' })).toEqual({ _tag: 'Err', reason: 'SizeLimit' })
    expect(channel.transmit({ type: 'Text', text: '中'.repeat(21845) })).toEqual({ _tag: 'Ok', value: 1 })
    expect(messages).toHaveLength(1)
  })
  it.each([
    { key: 175 },
    { action: -1 },
    { mods: 64 },
    { consumedMods: 64 },
    { composing: 1 },
    { unshiftedCodepoint: 0x110000 },
    { utf8: '中'.repeat(43) },
    { utf8: '\0' },
  ])('rejects invalid key events without consuming sequence: %o', (change) => {
    const { channel } = setup()
    expect(
      channel.transmit({ type: 'Key', event: { action: 1, key: 1, mods: 0, ...change } } as TerminalInput),
    ).toEqual({ _tag: 'Err', reason: 'InvalidRequest' })
    expect(channel.transmit(key)).toEqual({ _tag: 'Ok', value: 1 })
  })
  it('validates resize area and mouse coordinates before writing', () => {
    const { channel, messages } = setup()
    expect(channel.transmit({ type: 'Resize', cols: 500, rows: 200 })).toEqual({ _tag: 'Err', reason: 'SizeLimit' })
    expect(channel.transmit({ type: 'Mouse', action: 'down', button: 0, col: 0, row: 1, mods: 0 })).toEqual({
      _tag: 'Err',
      reason: 'InvalidRequest',
    })
    expect(channel.transmit({ type: 'Resize', cols: 100, rows: 30 })).toEqual({ _tag: 'Ok', value: 1 })
    expect(channel.transmit({ type: 'Focus', focused: true })).toEqual({ _tag: 'Ok', value: 2 })
    expect(messages).toEqual([
      { type: 'Resize', cols: 100, rows: 30, sequence: 1, lease: writer.lease },
      { type: 'Focus', focused: true, sequence: 2, lease: writer.lease },
    ])
  })
  it('refuses observer writes without creating unconfirmed input', () => {
    const { channel, messages } = setup()
    channel.setWriter({ ...writer, viewId: 'other' })
    expect(channel.transmit(key)).toEqual({ _tag: 'Err', reason: 'StaleWriter' })
    expect(channel.detach()).toEqual({ unconfirmed: false })
    expect(messages).toEqual([])
  })
  it('keeps sequence state when the same lease is renewed', () => {
    const { channel } = setup()
    channel.transmit(key)
    channel.setWriter({ ...writer, expiresAt: 200 })
    expect(channel.transmit(key)).toEqual({ _tag: 'Ok', value: 2 })
    expect(channel.receipt(1, writer.lease)).toBe(true)
    expect(channel.receipt(2, writer.lease)).toBe(true)
    expect(channel.detach()).toEqual({ unconfirmed: false })
  })
  it('fences old receipts when a new lease reuses sequence one', () => {
    const { channel } = setup()
    channel.transmit(key)
    channel.receipt(1, writer.lease)
    channel.setWriter({ ...writer, lease: 'lease-b' })
    expect(channel.transmit(key)).toEqual({ _tag: 'Ok', value: 1 })
    expect(channel.receipt(1, writer.lease)).toBe(false)
    expect(channel.detach()).toEqual({ unconfirmed: true })
  })
  it('leaves definitely refused sends available at the same sequence', () => {
    let accepted = false
    const { channel } = setup(() => accepted)
    expect(channel.transmit(key)).toEqual({ _tag: 'Err', reason: 'SessionUnavailable' })
    accepted = true
    expect(channel.transmit(key)).toEqual({ _tag: 'Ok', value: 1 })
  })
  it('fences uncertain sends and never replays them after a lease change', () => {
    const messages: TerminalClientMessage[] = []
    let uncertain = true
    const { channel } = setup((message) => {
      messages.push(message)
      if (uncertain) throw new Error('Socket delivery unknown')
      return true
    })
    expect(channel.transmit(key)).toEqual({ _tag: 'Err', reason: 'DeliveryUnknown' })
    expect(channel.transmit(key)).toEqual({ _tag: 'Err', reason: 'DeliveryUnknown' })
    channel.setWriter({ ...writer, expiresAt: 200 })
    expect(channel.transmit(key)).toEqual({ _tag: 'Err', reason: 'DeliveryUnknown' })
    uncertain = false
    channel.setWriter({ ...writer, lease: 'lease-b' })
    expect(messages).toHaveLength(1)
    expect(channel.transmit(key)).toEqual({ _tag: 'Ok', value: 1 })
    expect(messages).toHaveLength(2)
    expect(channel.receipt(1, writer.lease)).toBe(false)
    expect(channel.receipt(1, 'lease-b')).toBe(true)
    expect(channel.detach()).toEqual({ unconfirmed: true })
  })
  it('reports unconfirmed input after writer loss and rejects forged receipts', () => {
    const { channel } = setup()
    channel.transmit(key)
    expect(channel.receipt(999, writer.lease)).toBe(false)
    channel.setWriter(null)
    expect(channel.detach()).toEqual({ unconfirmed: true })
  })
  it('does not reset a reused lease after detaching with acknowledged input', () => {
    const { channel } = setup()
    channel.transmit(key)
    channel.receipt(1, writer.lease)
    expect(channel.detach()).toEqual({ unconfirmed: false })
    channel.setWriter(writer)
    expect(channel.transmit(key)).toEqual({ _tag: 'Ok', value: 2 })
  })
  it('fences a reused lease after detaching with unacknowledged input', () => {
    const { channel } = setup()
    channel.transmit(key)
    channel.detach()
    channel.setWriter(writer)
    expect(channel.transmit(key)).toEqual({ _tag: 'Err', reason: 'DeliveryUnknown' })
  })
})
