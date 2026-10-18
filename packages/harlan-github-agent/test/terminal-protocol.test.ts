import { describe, expect, it } from 'vitest'
import {
  normalizeTerminalExit,
  parseTerminalClientMessage,
  parseTerminalJson,
  parseTerminalLaunch,
} from '../src/terminal.ts'

describe('terminal request boundaries', () => {
  it('normalizes bounded PTY exit codes and signals without exposing other data', () => {
    expect(normalizeTerminalExit({ exitCode: 0, signal: 0 })).toEqual({ code: 0 })
    expect(normalizeTerminalExit({ exitCode: 23, signal: 0 })).toEqual({ code: 23 })
    expect(normalizeTerminalExit({ exitCode: -1, signal: 9 })).toEqual({ signal: 9 })
    expect(normalizeTerminalExit({ exitCode: 300, signal: 999 })).toBeUndefined()
  })
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
    for (const fields of [{ requestId: 'one\n' }, { projectId: 'project\r' }, { mode: 'automatic-force' }, { initialPrompt: 'invalid\0prompt' }])
      expect(parseTerminalLaunch({ requestId: 'one', projectId: 'project', provider: 'codex', ...fields })).toEqual({ _tag: 'Err', reason: 'InvalidRequest' })
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

it('parses bounded history requests and refuses malformed snapshot identifiers', () => {
  const request = { type: 'History', requestId: 'read-1', snapshot: null, offset: null, limit: 200 }
  expect(parseTerminalClientMessage(request)).toEqual({ _tag: 'Ok', value: request })
  expect(parseTerminalClientMessage({ ...request, snapshot: 'copy-1', offset: 800 })).toMatchObject({ _tag: 'Ok', value: { snapshot: 'copy-1', offset: 800 } })
  for (const change of [{ requestId: '' }, { snapshot: 5 }, { offset: -1 }, { limit: 201 }])
    expect(parseTerminalClientMessage({ ...request, ...change })).toEqual({ _tag: 'Err', reason: 'InvalidRequest' })
})
