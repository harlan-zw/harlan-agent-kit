import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

it('exports native V2 session tools and token usage through the weekly report', async () => {
  const home = mkdtempSync(join(tmpdir(), 'opencode-v2-export-'))
  try {
    const directory = join(home, '.local/share/opencode')
    mkdirSync(directory, { recursive: true })
    const database = new DatabaseSync(join(directory, 'opencode.db'))
    const now = Date.now()
    database.exec(`CREATE TABLE session_v2 (id TEXT, title TEXT, directory TEXT, model TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, idle_outcome TEXT);
      CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);`)
    database
      .prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, NULL, ?, ?, 10, 2, 0, 4, 'succeeded')")
      .run(
        'ses_v2',
        'V2 fixture',
        '/tmp/repo.wolfstar-agent-baseline-cccccccccccc-dddddddddddd',
        JSON.stringify({ providerID: 'fixture', modelID: 'native-model' }),
        now - 1000,
        now,
      )
    const insert = database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)')
    insert.run('msg_user', 'ses_v2', 'user', 0, now - 1000, now - 1000, JSON.stringify({ text: 'Read the fixture.' }))
    insert.run(
      'msg_answer',
      'ses_v2',
      'assistant',
      1,
      now - 800,
      now,
      JSON.stringify({
        content: [
          {
            type: 'tool',
            id: 'call_one',
            name: 'shell',
            state: {
              status: 'completed',
              input: { command: 'echo fixture' },
              content: [{ type: 'text', text: 'fixture' }],
              metadata: { exit: 0 },
            },
            time: { created: now - 800, ran: now - 700, completed: now - 200 },
          },
          { type: 'text', text: 'Done.' },
        ],
        finish: 'stop',
        tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 4, write: 0 } },
      }),
    )
    insert.run('msg_idle', 'ses_v2', 'idle', 2, now, now, JSON.stringify({ outcome: 'succeeded' }))
    database.close()
    const output = join(home, 'out')
    await execute('python3', [fileURLToPath(new URL('./export-sessions.py', import.meta.url)), output], {
      env: { ...process.env, HOME: home },
    })
    const summary = readFileSync(join(output, 'baseline_repair/INDEX.md'), 'utf8')
      .split('\n')
      .find((line) => line.startsWith('{'))!
    expect(JSON.parse(summary)).toMatchObject({
      id: 'ses_v2',
      model: 'native-model',
      tokens_in: 10,
      tokens_out: 2,
      cache_read: 4,
      tools: { shell: 1 },
      end_reason: 'completed',
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
