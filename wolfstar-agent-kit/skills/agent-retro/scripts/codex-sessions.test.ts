import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { parseCodexSession } from './codex-sessions.ts'

function log(records: unknown[]) {
  return records.map((record) => JSON.stringify(record)).join('\n')
}
const meta = {
  type: 'session_meta',
  timestamp: '2026-10-12T01:00:00Z',
  payload: { id: 'session-a', cwd: '/repo.wolfstar-agent-review-12-aaaaaaaaaaaa' },
}

describe('codex retro transcripts', () => {
  it('reads completed command events once, with output and completion state', () => {
    const event = {
      type: 'event_msg',
      timestamp: '2026-10-12T01:01:00Z',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'exec-a',
          command: ['/bin/sh', '-lc', 'hw status'],
          aggregated_output: 'command missing',
          exit_code: 127,
          status: 'completed',
        },
      },
    }
    const result = parseCodexSession(
      log([
        meta,
        event,
        event,
        { type: 'event_msg', timestamp: '2026-10-12T01:02:00Z', payload: { type: 'task_complete' } },
      ]),
    )
    expect(result.session?.parts).toHaveLength(1)
    expect(JSON.parse(result.session!.parts[0]!.data).state).toMatchObject({
      input: { command: 'hw status' },
      output: 'command missing',
      metadata: { exit: 127 },
    })
    expect(result.session?.end_reason).toBe('completed')
  })
  it('joins older calls to their output and reports incomplete sessions', () => {
    const result = parseCodexSession(
      log([
        meta,
        {
          type: 'response_item',
          timestamp: '2026-10-12T01:01:00Z',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'old-a',
            arguments: JSON.stringify({ cmd: 'hw runners' }),
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-10-12T01:02:00Z',
          payload: { type: 'function_call_output', call_id: 'old-a', output: 'runner active' },
        },
      ]),
    )
    expect(JSON.parse(result.session!.parts[0]!.data).state).toMatchObject({
      input: { command: 'hw runners' },
      output: 'runner active',
    })
    expect(result.session?.end_reason).toBe('incomplete')
  })
  it('counts malformed records without losing valid commands', () => {
    const result = parseCodexSession(`${log([meta])}\n{broken\n`)
    expect(result.malformed).toBe(1)
    expect(result.session?.id).toBe('session-a')
  })
})

it('exports Codex-only evidence through the existing redaction and Journal pipeline', async () => {
  const execute = promisify(execFile)
  const home = await mkdtemp(join(tmpdir(), 'codex-retro-'))
  try {
    const root = join(home, '.codex/sessions')
    await mkdir(root, { recursive: true })
    const at = new Date().toISOString()
    const secret = 'synthetic-secret-that-must-never-export'
    await writeFile(join(home, 'fixture.env'), `PRIVATE_KEY=${secret}\n`)
    await writeFile(
      join(root, 'rollout.jsonl'),
      `${log([
        { ...meta, timestamp: at },
        { type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: `Inspect ${secret}` } },
        {
          type: 'event_msg',
          timestamp: at,
          payload: {
            type: 'item_completed',
            item: {
              type: 'CommandExecution',
              id: 'command-a',
              command: ['/bin/sh', '-lc', 'hw status'],
              status: 'completed',
              aggregated_output: secret,
              exit_code: 0,
            },
          },
        },
        { type: 'event_msg', timestamp: at, payload: { type: 'task_complete' } },
      ])}\n{invalid\n`,
    )
    await execute(
      'python3',
      [
        join(import.meta.dirname, 'export-sessions.py'),
        join(home, 'out'),
        '--redact-env-file',
        join(home, 'fixture.env'),
        '--codex-node',
        process.execPath,
      ],
      { env: { ...process.env, HOME: home } },
    )
    const transcript = await readFile(join(home, 'out/adversarial_review/session-a.md'), 'utf8')
    expect(transcript).toContain('TOOL bash (completed exit=0)')
    expect(transcript).toContain('end_reason: completed')
    expect(transcript).not.toContain(secret)
    const index = await readFile(join(home, 'out/INDEX.md'), 'utf8')
    expect(index).toContain('Codex sessions: 1, malformed Codex records: 1')
    expect(await readFile(join(home, 'out/adversarial_review/INDEX.md'), 'utf8')).not.toContain(secret)
  } finally {
    await rm(home, { recursive: true })
  }
})

it('keeps older commands when a session resumes with modern events', () => {
  const result = parseCodexSession(
    log([
      meta,
      {
        type: 'response_item',
        timestamp: '2026-10-12T01:01:00Z',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'old',
          arguments: JSON.stringify({ cmd: 'hw status' }),
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-10-12T01:02:00Z',
        payload: { type: 'function_call_output', call_id: 'old', output: 'old output' },
      },
      {
        type: 'event_msg',
        timestamp: '2026-10-12T01:03:00Z',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            id: 'new',
            command: ['hw', 'runners'],
            aggregated_output: 'new output',
            exit_code: 0,
          },
        },
      },
    ]),
  )
  expect(result.session?.parts.map((part) => JSON.parse(part.data).state.input.command)).toEqual([
    'hw status',
    'hw runners',
  ])
})
