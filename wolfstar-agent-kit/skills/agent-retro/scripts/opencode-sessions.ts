import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

type Result<T> = { _tag: 'Ok'; value: T } | { _tag: 'Err'; error: string }
interface Part {
  data: string
  mdata: string
  time_created: number
}
interface RecordedSession {
  id: string
  title: string
  directory: string
  model: string
  parent_id: string | null
  time_created: number
  time_updated: number
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  end_reason?: string
}
const ok = <T>(value: T): Result<T> => ({ _tag: 'Ok', value })
const err = (error: string): Result<never> => ({ _tag: 'Err', error })
const record = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function json(value: unknown): Result<Record<string, any>> {
  if (typeof value !== 'string') return err('The OpenCode archive contains invalid JSON data.')
  try {
    const parsed: unknown = JSON.parse(value)
    return record(parsed) ? ok(parsed) : err('The OpenCode archive contains invalid JSON data.')
  } catch (error) {
    if (error instanceof SyntaxError) return err('The OpenCode archive contains malformed JSON data.')
    throw error
  }
}

function metadata(row: Record<string, any>, format: 'v2' | 'historical'): Result<RecordedSession> {
  if (
    typeof row.id !== 'string' ||
    typeof row.directory !== 'string' ||
    !Number.isFinite(row.time_created) ||
    !Number.isFinite(row.time_updated)
  ) {
    return err('The OpenCode archive contains invalid session metadata.')
  }
  const model = json(row.model || '{}')
  if (model._tag === 'Err') return model
  return ok({
    id: row.id,
    title: row.title ?? '',
    directory: row.directory,
    model: JSON.stringify({ ...model.value, id: model.value.modelID ?? model.value.id }),
    parent_id: row.parent_id ?? null,
    time_created: row.time_created,
    time_updated: row.time_updated,
    tokens_input: row.tokens_input ?? 0,
    tokens_output: row.tokens_output ?? 0,
    tokens_reasoning: row.tokens_reasoning ?? 0,
    tokens_cache_read: row.tokens_cache_read ?? 0,
    ...(format === 'historical'
      ? {}
      : { end_reason: row.idle_outcome === 'succeeded' ? 'completed' : (row.idle_outcome ?? 'incomplete') }),
  })
}

function tables(database: DatabaseSync): Set<string> {
  return new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => String(row.name)),
  )
}

/** V2 projections take precedence over retained V1 historical records with the same identity. */
export function readOpencodeSessions(path: string, since: number): Result<{ sessions: RecordedSession[] }> {
  if (!existsSync(path)) return ok({ sessions: [] })
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const names = tables(database)
    const sessions = new Map<string, RecordedSession>()
    for (const table of ['session', 'session_v2']) {
      if (!names.has(table)) continue
      const rows = database
        .prepare(`SELECT * FROM ${table} WHERE time_created > ? AND parent_id IS NULL ORDER BY time_created DESC`)
        .all(since)
      for (const row of rows) {
        const parsed = metadata(row, table === 'session_v2' ? 'v2' : 'historical')
        if (parsed._tag === 'Err') return parsed
        sessions.set(parsed.value.id, parsed.value)
      }
    }
    return ok({ sessions: [...sessions.values()].sort((a, b) => b.time_created - a.time_created) })
  } finally {
    database.close()
  }
}

function messageParts(rows: Record<string, any>[]): Result<Part[]> {
  const parts: Part[] = []
  for (const row of rows) {
    const parsed = json(row.data)
    if (parsed._tag === 'Err') return parsed
    const message = parsed.value
    const append = (data: unknown, time = row.time_created, role = 'assistant') => {
      parts.push({ data: JSON.stringify(data), mdata: JSON.stringify({ role }), time_created: time })
    }
    if (row.type === 'user' || row.type === 'synthetic') {
      if (typeof message.text === 'string') append({ type: 'text', text: message.text }, row.time_created, 'user')
    } else if (row.type === 'idle') {
      append({ type: 'step-finish', reason: message.outcome === 'succeeded' ? 'stop' : message.outcome })
    } else if (row.type === 'assistant') {
      if (!Array.isArray(message.content)) return err('The OpenCode archive contains invalid assistant content.')
      for (const item of message.content) {
        if (!record(item)) return err('The OpenCode archive contains invalid assistant content.')
        if (item.type === 'text' || item.type === 'reasoning') {
          append({ type: item.type, text: item.text })
        } else if (item.type === 'tool') {
          if (!record(item.state) || typeof item.name !== 'string')
            return err('The OpenCode archive contains invalid tool activity.')
          const state = item.state
          const output = Array.isArray(state.content)
            ? state.content
                .filter((part: unknown) => record(part) && part.type === 'text')
                .map((part: { text: string }) => part.text)
                .join('\n')
            : ''
          append(
            {
              type: 'tool',
              tool: item.name,
              state: {
                status: state.status,
                input: record(state.input) ? state.input : {},
                output,
                error: record(state.error) ? state.error.message : undefined,
                metadata: state.metadata,
                time: { start: item.time?.ran ?? item.time?.created, end: item.time?.completed },
              },
            },
            item.time?.created ?? row.time_created,
          )
        }
      }
      if (record(message.error)) append({ type: 'text', text: `ERROR: ${message.error.message}` })
      if (typeof message.finish === 'string') append({ type: 'step-finish', reason: message.finish }, row.time_updated)
    }
  }
  return ok(parts)
}

export function readOpencodeSession(
  path: string,
  id: string,
): Result<{ session: (RecordedSession & { parts: Part[] }) | null }> {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const names = tables(database)
    for (const table of ['session_v2', 'session']) {
      if (!names.has(table)) continue
      const row = database.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)
      if (!row) continue
      const parsed = metadata(row, table === 'session_v2' ? 'v2' : 'historical')
      if (parsed._tag === 'Err') return parsed
      const parts =
        table === 'session_v2'
          ? messageParts(database.prepare('SELECT * FROM session_message WHERE session_id=? ORDER BY seq, id').all(id))
          : ok(
              database
                .prepare(
                  'SELECT p.data, p.time_created, m.data AS mdata FROM part p JOIN message m ON m.id=p.message_id WHERE p.session_id=? ORDER BY p.time_created, p.id',
                )
                .all(id) as unknown as Part[],
            )
      return parts._tag === 'Err' ? parts : ok({ session: { ...parsed.value, parts: parts.value } })
    }
    return ok({ session: null })
  } finally {
    database.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { database: { type: 'string' }, since: { type: 'string', default: '0' }, session: { type: 'string' } },
  })
  const path = values.database ?? join(homedir(), '.local/share/opencode/opencode.db')
  const result =
    values.session === undefined
      ? readOpencodeSessions(path, Number(values.since))
      : readOpencodeSession(path, values.session)
  if (result._tag === 'Err') throw new Error(result.error)
  process.stdout.write(JSON.stringify(result.value))
}
