import { describe, expect, it } from 'vitest'
import {
  parseTerminalCapabilities,
  parseTerminalFrame,
  parseTerminalProjects,
  parseTerminalServerMessage,
  parseTerminalSessionResult,
  parseTerminalSessions,
} from '../dashboard/app/utils/terminal-protocol.ts'

const session = {
  id: 'session',
  generation: 'generation',
  projectId: 'project',
  provider: 'codex',
  hostId: 'host',
  bootId: 'boot',
  state: 'Running',
  createdAt: '2026-10-12T03:54:17.000Z',
  worktree: null,
}
const capabilities = {
  protocol: 1,
  hostId: 'host',
  bootId: 'boot',
  hostLabel: 'Desktop',
  controller: true,
  controllerReadOnly: false,
  providers: { codex: true, claude: false, opencode: true },
  supports: { terminal: true, stop: true, writer: true, resize: true, mouse: true, focus: true },
}
const cell = {
  codepoint: 0x4e2d,
  fg_r: 255,
  fg_g: 0,
  fg_b: 10,
  bg_r: 0,
  bg_g: 10,
  bg_b: 20,
  flags: 1,
  width: 2,
  hyperlink_id: 0,
  grapheme_len: 0,
}
function screen() {
  return {
    revision: 1,
    scrollbackLength: 2,
    dimensions: { cols: 2, rows: 2 },
    cursor: { x: 1, y: 0, visible: true },
    lines: [
      [{ ...cell }, { ...cell, codepoint: 0, width: 0 }],
      [{ ...cell }, { ...cell, codepoint: 0, width: 0 }],
    ],
    graphemes: [
      ['中', ' '],
      ['👩‍💻', ' '],
    ],
    wrapped: [true, false],
    modes: { alternate: false, paste: true, focus: true, mouse: false, keyboard: 11 },
  }
}
const error = { _tag: 'Err', reason: 'InvalidRequest' }
const size = { _tag: 'Err', reason: 'SizeLimit' }

describe('terminal browser boundary', () => {
  it('projects known capability fields and rejects partial support claims', () => {
    expect(parseTerminalCapabilities({ ...capabilities, token: 'secret' })).toEqual({ _tag: 'Ok', value: capabilities })
    expect(parseTerminalCapabilities({ ...capabilities, protocol: '1' })).toEqual(error)
    expect(
      parseTerminalCapabilities({ ...capabilities, supports: { ...capabilities.supports, resize: false } }),
    ).toEqual(error)
    expect(
      parseTerminalCapabilities({ ...capabilities, providers: { ...capabilities.providers, codex: 'true' } }),
    ).toEqual(error)
    expect(parseTerminalCapabilities({ ...capabilities, controllerReadOnly: true })).toEqual({
      _tag: 'Ok',
      value: { ...capabilities, controllerReadOnly: true },
    })
    expect(parseTerminalCapabilities({ ...capabilities, controller: false, controllerReadOnly: true })).toEqual(error)
  })
  it('projects inventory fields into fresh values and rejects duplicate identities', () => {
    const project = { id: 'p', name: 'Project', path: '/home/project' }
    expect(parseTerminalProjects([{ ...project, environment: 'secret' }])).toEqual({ _tag: 'Ok', value: [project] })
    expect(parseTerminalProjects([project, project])).toEqual(error)
    expect(parseTerminalSessions([{ ...session, pid: 10 }])).toEqual({ _tag: 'Ok', value: [session] })
    expect(parseTerminalSessions([session, session])).toEqual(error)
    expect(parseTerminalProjects(Array.from({ length: 20_001 }).fill(project))).toEqual(size)
  })
  it.each([
    { provider: 'cursor' },
    { provider: { toString: (): string => 'codex' } },
    { state: 'running' },
    { worktree: 2 },
    { id: '' },
    { generation: 'g\0x' },
    { createdAt: 'yesterday' },
    { createdAt: '2026-99-12T00:00:00Z' },
  ])('rejects malformed session data: %o', (change) => {
    expect(parseTerminalSessions([{ ...session, ...change }])).toEqual(error)
  })
  it('parses session results without trusting a success tag', () => {
    expect(parseTerminalSessionResult({ _tag: 'Ok', value: session })).toEqual({ _tag: 'Ok', value: session })
    expect(parseTerminalSessionResult({ _tag: 'Ok', value: {} })).toEqual(error)
    expect(parseTerminalSessionResult({ _tag: 'Err', reason: 'CapacityRefused' })).toEqual({
      _tag: 'Err',
      reason: 'CapacityRefused',
    })
    expect(parseTerminalSessionResult({ _tag: 'Err', reason: 'made-up' })).toEqual(error)
  })
  it('preserves wide glyphs and projects all screen fields without retaining aliases', () => {
    const input = screen()
    const result = parseTerminalServerMessage({ type: 'Screen', generation: 'g', screen: { ...input, auth: 'secret' } })
    expect(result).toEqual({ _tag: 'Ok', value: { type: 'Screen', generation: 'g', screen: input } })
    input.lines[0]![0]!.fg_r = 0
    input.graphemes[0]![0] = 'changed'
    if (result._tag === 'Ok' && result.value.type === 'Screen') {
      expect(result.value.screen.lines[0]![0]!.fg_r).toBe(255)
      expect(result.value.screen.graphemes[0]![0]).toBe('中')
    }
  })
  it.each([
    { cursor: { x: 2, y: 0, visible: true } },
    { cursor: { x: 0, y: -1, visible: true } },
    { lines: [[cell]] },
    { graphemes: [['中'], ['x', 'y']] },
    { wrapped: [true, 1] },
    { modes: { alternate: false, paste: true, focus: true, mouse: false, keyboard: 32 } },
  ])('rejects inconsistent screen metadata: %o', (change) => {
    expect(parseTerminalServerMessage({ type: 'Screen', generation: 'g', screen: { ...screen(), ...change } })).toEqual(
      error,
    )
  })
  it.each([
    { codepoint: 0xd800 },
    { codepoint: 0x110000 },
    { fg_r: 256 },
    { flags: -1 },
    { width: 3 },
    { hyperlink_id: 65536 },
    { grapheme_len: 256 },
    { bg_b: NaN },
  ])('rejects invalid cells: %o', (change) => {
    const input = screen()
    Object.assign(input.lines[0]![0]!, change)
    expect(parseTerminalServerMessage({ type: 'Screen', generation: 'g', screen: input })).toEqual(error)
  })
  it('bounds cell count and grapheme storage', () => {
    expect(
      parseTerminalServerMessage({
        type: 'Screen',
        generation: 'g',
        screen: { ...screen(), dimensions: { cols: 500, rows: 200 } },
      }),
    ).toEqual(size)
    const input = screen()
    input.graphemes[0]![0] = 'x'.repeat(4097)
    expect(parseTerminalServerMessage({ type: 'Screen', generation: 'g', screen: input })).toEqual(size)
    input.graphemes[0]![0] = '\uD800'
    expect(parseTerminalServerMessage({ type: 'Screen', generation: 'g', screen: input })).toEqual(error)
  })
  it('checks scrollback offsets and matched rows', () => {
    const message = { type: 'Scrollback', generation: 'g', total: 10, offset: 9, lines: [[cell]], graphemes: [['中']] }
    expect(parseTerminalServerMessage(message)).toEqual({ _tag: 'Ok', value: message })
    expect(parseTerminalServerMessage({ ...message, offset: 10 })).toEqual(error)
    expect(parseTerminalServerMessage({ ...message, graphemes: [] })).toEqual(error)
    expect(parseTerminalServerMessage({ ...message, total: -1 })).toEqual(error)
  })
  it('validates writer leases and every small server message', () => {
    const writer = { viewId: 'view', lease: 'lease', expiresAt: 100 }
    const messages = [
      { type: 'Attached', protocol: 1, session, writer },
      { type: 'WriterChanged', writer },
      { type: 'WriterChanged', writer: null },
      { type: 'InputReceipt', sequence: 1, lease: 'lease' },
      { type: 'Process', state: 'Exited' },
      { type: 'Failure', reason: 'DeliveryUnknown' },
    ]
    for (const message of messages) expect(parseTerminalServerMessage(message)).toEqual({ _tag: 'Ok', value: message })
    expect(parseTerminalServerMessage({ type: 'WriterChanged', writer: { ...writer, expiresAt: Infinity } })).toEqual(
      error,
    )
    expect(parseTerminalServerMessage({ type: 'InputReceipt', sequence: 0 })).toEqual(error)
    expect(parseTerminalServerMessage({ type: 'InputReceipt', sequence: 1 })).toEqual(error)
    expect(parseTerminalServerMessage({ type: 'InputReceipt', sequence: 1, lease: '' })).toEqual(error)
    expect(parseTerminalServerMessage({ type: 'Unknown' })).toEqual(error)
  })
  it('rejects malformed and oversized UTF8 frames before use', () => {
    expect(parseTerminalFrame('{')).toEqual(error)
    expect(parseTerminalFrame('null')).toEqual(error)
    expect(parseTerminalFrame('"中"'.repeat(3_000_000))).toEqual(size)
    expect(parseTerminalFrame(JSON.stringify({ type: 'InputReceipt', sequence: 5, lease: 'lease' }))).toEqual({
      _tag: 'Ok',
      value: { type: 'InputReceipt', sequence: 5, lease: 'lease' },
    })
  })
})
