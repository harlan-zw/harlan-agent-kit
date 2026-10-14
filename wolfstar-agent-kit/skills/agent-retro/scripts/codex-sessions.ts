import { createReadStream, existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

interface Part {
  data: string
  mdata: string
  time_created: number
}
interface CodexSession {
  id: string
  provider: 'codex'
  title: string
  directory: string
  model: string
  time_created: number
  time_updated: number
  parent_id: string | null
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  end_reason: 'completed' | 'incomplete'
  parts: Part[]
}

function record(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined
}

function codexParser(includeParts: boolean) {
  let session: CodexSession | undefined
  let malformed = 0
  const seen = new Set<string>()
  const calls = new Map<string, Part>()
  const append = (data: unknown, time: number, role = 'assistant') => {
    if (session !== undefined && includeParts)
      session.parts.push({ data: JSON.stringify(data), mdata: JSON.stringify({ role }), time_created: time })
  }
  function accept(raw: string) {
    if (!raw.trim()) return
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      malformed++
      return
    } // Corrupt records are counted in the export index.
    const line = record(value)
    const payload = record(line?.payload)
    const time = Date.parse(String(line?.timestamp))
    if (line === undefined || payload === undefined || !Number.isFinite(time)) {
      malformed++
      return
    }
    if (line.type === 'session_meta') {
      if (typeof payload.id !== 'string' || !/^[\w-]+$/.test(payload.id) || typeof payload.cwd !== 'string') {
        malformed++
        return
      }
      session = {
        id: payload.id,
        provider: 'codex',
        title: payload.id,
        directory: payload.cwd,
        model: '{}',
        time_created: time,
        time_updated: time,
        parent_id: payload.parent_thread_id ?? null,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        end_reason: 'incomplete',
        parts: [],
      }
      return
    }
    if (session === undefined) return
    session.time_updated = Math.max(time, session.time_updated)
    if (line.type === 'turn_context' && typeof payload.model === 'string')
      session.model = JSON.stringify({ id: payload.model })
    if (line.type === 'event_msg') {
      if (payload.type === 'task_started' || payload.type === 'turn_started') session.end_reason = 'incomplete'
      if (payload.type === 'task_complete' || payload.type === 'turn_completed') session.end_reason = 'completed'
      if (payload.type === 'token_count') {
        const usage = record(payload.info)?.total_token_usage
        if (record(usage)) {
          session.tokens_input = usage.input_tokens ?? 0
          session.tokens_output = usage.output_tokens ?? 0
          session.tokens_reasoning = usage.reasoning_output_tokens ?? 0
          session.tokens_cache_read = usage.cached_input_tokens ?? 0
        }
      }
      if (payload.type === 'user_message' && typeof payload.message === 'string') {
        if (session.title === session.id) session.title = payload.message
        append({ type: 'text', text: payload.message }, time, 'user')
      }
      if (payload.type === 'agent_message' && typeof payload.message === 'string')
        append({ type: 'text', text: payload.message }, time)
      const item = record(payload.item)
      if (payload.type === 'item_completed' && item?.type === 'CommandExecution') {
        if (typeof item.id !== 'string' || seen.has(item.id)) return
        seen.add(item.id)
        const command = Array.isArray(item.command)
          ? (['-c', '-lc'].includes(item.command[1]) ? item.command.slice(2) : item.command).join(' ')
          : String(item.command ?? '')
        append(
          {
            type: 'tool',
            tool: 'bash',
            state: {
              input: { command },
              output: item.aggregated_output ?? '',
              status: item.status ?? 'completed',
              metadata: { exit: item.exit_code },
            },
          },
          time,
        )
      }
      if (payload.type === 'item_completed' && item?.type === 'AgentMessage' && typeof item.text === 'string')
        append({ type: 'text', text: item.text }, time)
    }
    if (!includeParts || line.type !== 'response_item') return
    if (
      (payload.type === 'function_call' || payload.type === 'custom_tool_call') &&
      typeof payload.call_id === 'string'
    ) {
      let input: unknown
      try {
        input = payload.type === 'custom_tool_call' ? { code: payload.input } : JSON.parse(payload.arguments)
      } catch {
        malformed++
        return
      }
      const command = record(input)?.cmd ?? record(input)?.command
      calls.set(payload.call_id, {
        data: JSON.stringify({
          type: 'tool',
          tool: typeof command === 'string' ? 'bash' : payload.name,
          state: { input: typeof command === 'string' ? { command } : input, status: 'running' },
        }),
        mdata: '{"role":"assistant"}',
        time_created: time,
      })
    }
    if (
      (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') &&
      calls.has(payload.call_id)
    ) {
      const part = calls.get(payload.call_id)!
      const data = JSON.parse(part.data)
      data.state.output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output)
      data.state.status = 'completed'
      part.data = JSON.stringify(data)
    }
    if (payload.type === 'message' && ['user', 'assistant'].includes(payload.role) && Array.isArray(payload.content)) {
      const text = payload.content.map((item: any) => item.text ?? '').join('\n')
      if (text) append({ type: 'text', text }, time, payload.role)
    }
  }
  return {
    accept,
    finish() {
      if (session !== undefined && includeParts)
        session.parts.push(...[...calls.entries()].filter(([id]) => !seen.has(id)).map(([, part]) => part))
      session?.parts.sort((a, b) => a.time_created - b.time_created)
      return { session, malformed }
    },
  }
}

export function parseCodexSession(text: string) {
  const parser = codexParser(true)
  text.split('\n').forEach(parser.accept)
  return parser.finish()
}

async function readSession(path: string, includeParts: boolean) {
  const parser = codexParser(includeParts)
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) parser.accept(line)
  return parser.finish()
}

async function* files(directory: string): AsyncGenerator<string> {
  if (!existsSync(directory)) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path
  }
}

async function main(args: string[]) {
  if (args[0] === '--file') {
    console.log(JSON.stringify(await readSession(args[1]!, true)))
    return
  }
  const since = Number(args[0])
  if (!Number.isFinite(since)) throw new Error('Set the earliest session timestamp in milliseconds.')
  const roots = args.slice(1)
  if (roots.length === 0)
    roots.push(
      join(homedir(), '.codex/sessions'),
      join(homedir(), '.local/share/wolfstar-agent-kit/worker-home/.codex/sessions'),
    )
  const sessions = new Map<string, CodexSession & { file: string }>()
  let malformed = 0
  for (const root of roots) {
    for await (const file of files(resolve(root))) {
      if ((await stat(file)).mtimeMs < since) continue
      const result = await readSession(file, false)
      malformed += result.malformed
      const session = result.session
      if (session === undefined || session.time_updated < since) continue
      const existing = sessions.get(session.id)
      if (existing === undefined || existing.time_updated < session.time_updated)
        sessions.set(session.id, { ...session, file })
    }
  }
  console.log(JSON.stringify({ sessions: [...sessions.values()], malformed }))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Codex transcript export failed.')
    process.exitCode = 1
  })
}
