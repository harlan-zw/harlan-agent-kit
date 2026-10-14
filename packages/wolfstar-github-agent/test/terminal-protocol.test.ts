import { describe, expect, it } from 'vitest'
import { parseTerminalClientMessage, parseTerminalJson, parseTerminalLaunch } from '../src/terminal.ts'

describe('terminal request boundaries', () => {
  it('rejects provider arrays rather than coercing them into provider names', () => {
    expect(
      parseTerminalLaunch({
        requestId: 'one',
        projectId: 'project',
        provider: ['codex'],
      }),
    ).toEqual({ _tag: 'Err', reason: 'InvalidRequest' })
  })
  it('rejects string mouse buttons rather than coercing them into integers', () => {
    expect(
      parseTerminalClientMessage({
        type: 'Mouse',
        lease: 'lease',
        sequence: 1,
        action: 'down',
        button: '0',
        col: 1,
        row: 1,
        mods: 0,
      }),
    ).toEqual({ _tag: 'Err', reason: 'InvalidRequest' })
  })
  it('returns a precise launch without caller fields', () => {
    expect(
      parseTerminalLaunch({
        requestId: 'one',
        projectId: 'project',
        provider: 'codex',
        executable: '/bin/rm',
      }),
    ).toEqual({
      _tag: 'Ok',
      value: { requestId: 'one', projectId: 'project', provider: 'codex' },
    })
  })
  it('refuses control characters in identities and unknown admission modes', () => {
    for (const fields of [
      { requestId: 'one\n' },
      { projectId: 'project\r' },
      { mode: 'automatic-force' },
      { initialPrompt: 'invalid\0prompt' },
    ])
      expect(parseTerminalLaunch({ requestId: 'one', projectId: 'project', provider: 'codex', ...fields })).toEqual({
        _tag: 'Err',
        reason: 'InvalidRequest',
      })
  })
  it('refuses malformed JSON without throwing', () => {
    expect(parseTerminalJson('{')).toEqual({
      _tag: 'Err',
      reason: 'InvalidRequest',
    })
  })
  it('refuses oversized dimensions and pasted text', () => {
    expect(
      parseTerminalClientMessage({
        type: 'Resize',
        lease: 'lease',
        sequence: 1,
        cols: 500,
        rows: 200,
      }),
    ).toEqual({ _tag: 'Err', reason: 'SizeLimit' })
    expect(
      parseTerminalClientMessage({
        type: 'Paste',
        lease: 'lease',
        sequence: 1,
        text: '中'.repeat(30000),
      }),
    ).toEqual({ _tag: 'Err', reason: 'SizeLimit' })
  })
})
