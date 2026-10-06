import type { Result } from './result.ts'
import { MEDIA_LIMITS } from './github-media-limits.ts'
import { err, ok } from './result.ts'

export interface OpencodeResultLine { type: string, sessionID: string, part: Record<string, unknown> }
type ResultPart = Record<string, unknown> & { id: string }
// User file parts retain base64 media. Reserve that expansion plus bounded message overhead.
const maximumBytes = Math.ceil(MEDIA_LIMITS.totalBytes / 3) * 4 + 8 * 1024 * 1024
const maximumMessages = 1_024
const maximumParts = 4_096

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read only this turn's owned server. Never expose its auth or response in errors. */
interface ServerRead { url: string, password: string, workspace: string, signal: AbortSignal, fetch?: typeof fetch }

async function readOpencodeJson(input: ServerRead & { path: string, method?: string, body?: string }): Promise<Result<unknown, string>> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)])
  return (async (): Promise<Result<unknown, string>> => {
    const response = await (input.fetch ?? fetch)(`${input.url}${input.path}${input.path.includes('?') ? '&' : '?'}directory=${encodeURIComponent(input.workspace)}`, {
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.body === undefined ? {} : { body: input.body }),
      headers: { 'authorization': `Basic ${Buffer.from(`opencode:${input.password}`).toString('base64')}`, 'content-type': 'application/json' },
      signal,
      redirect: 'error',
    })
    if (!response.ok) {
      await response.body?.cancel()
      return err(`The OpenCode result read answered ${response.status}.`)
    }
    if (!response.body || !response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel()
      return err('The OpenCode result read returned no JSON body.')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        signal.throwIfAborted()
        const chunk = await reader.read()
        if (chunk.done)
          break
        bytes += chunk.value.byteLength
        if (bytes > maximumBytes)
          return err('The OpenCode result read exceeded its byte limit.')
        chunks.push(chunk.value)
      }
      const text = Buffer.concat(chunks, bytes).toString('utf8')
      // Invalid JSON is a boundary failure, not an empty successful result.
      return Promise.resolve().then(() => ok(JSON.parse(text) as unknown)).catch(() => err('The OpenCode result read returned invalid JSON.'))
    }
    finally {
      // Cancellation failures remain transport failures through the outer error boundary.
      await reader.cancel()
      reader.releaseLock()
    }
  })().catch(() => err(input.signal.aborted ? 'The OpenCode result read was cancelled.' : 'The OpenCode result read failed.'))
}

export function readOpencodeMessages(input: ServerRead & { sessionId: string }): Promise<Result<unknown, string>> {
  // One extra record detects truncation before accepting a supposedly sole parent user.
  return readOpencodeJson({ ...input, path: `/session/${encodeURIComponent(input.sessionId)}/message?limit=${maximumMessages + 1}` })
}

/** Start an empty session in the exact workspace, independent of CLI event delivery. */
export async function createOpencodeSession(input: ServerRead): Promise<Result<string, string>> {
  const result = await readOpencodeJson({ ...input, path: '/session', method: 'POST', body: JSON.stringify({ permission: ['question', 'plan_enter', 'plan_exit'].map(permission => ({ permission, pattern: '*', action: 'deny' })) }) })
  if (result._tag === 'Err')
    return result
  if (!record(result.value) || typeof result.value.id !== 'string' || !/^ses_[a-z\d]+$/i.test(result.value.id))
    return err('The OpenCode server returned an invalid session identity.')
  return ok(result.value.id)
}

/** Reconcile one parent user message, never an answer from an earlier turn. */
export function recoverOpencodeResult(value: unknown, sessionId: string, messageId: string | undefined, delivered: ReadonlySet<string>): Result<OpencodeResultLine[], string> {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumMessages)
    return err('The OpenCode result has an invalid message count.')
  const messages: Array<{ id: string, parentId: string, created: number, completed: number | undefined, finish: unknown, parts: ResultPart[] }> = []
  let partCount = 0
  const identities = new Set<string>()
  const users = new Set<string>()
  for (const entry of value) {
    if (!record(entry) || !record(entry.info) || !Array.isArray(entry.parts))
      return err('The OpenCode result contains an invalid message.')
    partCount += entry.parts.length
    if (partCount > maximumParts)
      return err('The OpenCode result exceeded its part limit.')
    const info = entry.info
    if (info.sessionID !== sessionId || typeof info.id !== 'string' || identities.has(info.id))
      return err('The OpenCode result message identity is invalid.')
    identities.add(info.id)
    if (info.role === 'user') {
      users.add(info.id)
      continue
    }
    if (info.role !== 'assistant' || typeof info.parentID !== 'string' || !record(info.time) || typeof info.time.created !== 'number' || !Number.isFinite(info.time.created))
      return err('The OpenCode assistant identity is invalid.')
    if (info.error !== undefined)
      return err('The OpenCode assistant reported an error.')
    const parts: ResultPart[] = []
    for (const part of entry.parts) {
      if (!record(part) || typeof part.id !== 'string' || part.sessionID !== sessionId || part.messageID !== info.id || typeof part.type !== 'string')
        return err('The OpenCode result part identity is invalid.')
      parts.push({ ...part, id: part.id })
    }
    messages.push({ id: info.id, parentId: info.parentID, created: info.time.created, completed: typeof info.time.completed === 'number' && Number.isFinite(info.time.completed) ? info.time.completed : undefined, finish: info.finish, parts })
  }
  const observed = messages.find(message => message.id === messageId)
  if (messageId !== undefined && !observed)
    return err('The OpenCode result does not contain the streamed assistant message.')
  // Without stream identity, one user message in our newly created empty session is unambiguous.
  const parentId = users.size === 1 ? (observed?.parentId ?? [...users][0]) : undefined
  if (parentId === undefined || !users.has(parentId))
    return err('The OpenCode result does not contain its parent user message.')
  const turn = messages.filter(message => message.parentId === parentId).sort((left, right) => left.created - right.created)
  const last = turn.at(-1)
  if (last === undefined || last.finish !== 'stop' || last.completed === undefined)
    return err('The OpenCode assistant did not complete its result.')
  const lines: OpencodeResultLine[] = []
  const seen = new Set<string>()
  let terminal = false
  let answer = false
  for (const message of turn) {
    for (const part of message.parts) {
      if (seen.has(part.id))
        return err('The OpenCode result repeats a part identity.')
      seen.add(part.id)
      if (part.type === 'text' || part.type === 'reasoning') {
        if (typeof part.text !== 'string' || !record(part.time) || typeof part.time.end !== 'number' || !Number.isFinite(part.time.end))
          return err('The OpenCode result contains unfinished text.')
        if (message.id === last.id && part.type === 'text' && part.text.trim())
          answer = true
        if (!delivered.has(part.id))
          lines.push({ type: part.type, sessionID: sessionId, part })
      }
      else if (part.type === 'tool') {
        const state = part.state
        if (typeof part.tool !== 'string' || !record(state) || !record(state.input)
          || !record(state.time) || [state.time.start, state.time.end].some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)
          || (state.status !== 'completed' && state.status !== 'error')) {
          return err('The OpenCode result contains unfinished tool activity.')
        }
        if ((state.status === 'completed' && typeof state.output !== 'string')
          || (state.status === 'error' && typeof state.error !== 'string')
          || (state.metadata !== undefined && (!record(state.metadata)
            || (state.metadata.exit !== undefined && (typeof state.metadata.exit !== 'number' || !Number.isFinite(state.metadata.exit)))
            || (state.metadata.output !== undefined && typeof state.metadata.output !== 'string')))) {
          return err('The OpenCode result contains invalid tool activity.')
        }
        if (!delivered.has(part.id))
          lines.push({ type: 'tool_use', sessionID: sessionId, part })
      }
      else if (part.type === 'step-finish') {
        if (typeof part.reason !== 'string' || !record(part.tokens) || !record(part.tokens.cache))
          return err('The OpenCode result contains an invalid completed step.')
        if ([part.tokens.input, part.tokens.output, part.tokens.reasoning, part.tokens.cache.read, part.tokens.cache.write].some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0))
          return err('The OpenCode result contains invalid token usage.')
        if (message.id === last.id && part.reason === 'stop')
          terminal = true
        if (!delivered.has(part.id))
          lines.push({ type: 'step_finish', sessionID: sessionId, part })
      }
    }
  }
  if (!terminal || !answer)
    return err('The OpenCode result has no terminal answer.')
  return ok(lines)
}
