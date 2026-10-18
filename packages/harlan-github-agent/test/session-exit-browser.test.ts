import { expect, it } from 'vitest'
import { parseTerminalFrame, parseTerminalSessionResult, parseTerminalSessions } from '../dashboard/app/utils/terminal-protocol.ts'

const session = { id: 'session', generation: 'generation', projectId: 'project', provider: 'codex', hostId: 'host', bootId: 'boot', state: 'Exited', createdAt: '2026-10-18T06:00:00.000Z', worktree: null }

it.each([{ code: 0 }, { code: 1 }, { signal: 15 }, { code: 0, signal: 9 }])('retains exit diagnosis from inventory, launch, attachment and live process frames: %j', (exit) => {
  const ended = { ...session, exit }
  expect(parseTerminalSessions([ended])).toEqual({ _tag: 'Ok', value: [ended] })
  expect(parseTerminalSessionResult({ _tag: 'Ok', value: ended })).toEqual({ _tag: 'Ok', value: ended })
  const attached = { type: 'Attached', protocol: 1, session: ended, writer: null }
  expect(parseTerminalFrame(JSON.stringify(attached))).toEqual({ _tag: 'Ok', value: attached })
  const process = { type: 'Process', state: 'Exited', exit }
  expect(parseTerminalFrame(JSON.stringify(process))).toEqual({ _tag: 'Ok', value: process })
})
it.each([null, {}, { code: '1' }, { code: -1 }, { code: 256 }, { signal: 0 }, { signal: 1.5 }])('rejects malformed exit diagnostics: %j', (exit) => {
  expect(parseTerminalSessions([{ ...session, exit }])).toEqual({ _tag: 'Err', reason: 'InvalidRequest' })
  expect(parseTerminalFrame(JSON.stringify({ type: 'Process', state: 'Exited', exit }))).toEqual({ _tag: 'Err', reason: 'InvalidRequest' })
})
it('still opens sessions from helpers that do not report exit details', () => {
  expect(parseTerminalSessions([session])).toEqual({ _tag: 'Ok', value: [session] })
  const process = { type: 'Process', state: 'Exited' }
  expect(parseTerminalFrame(JSON.stringify(process))).toEqual({ _tag: 'Ok', value: process })
})
