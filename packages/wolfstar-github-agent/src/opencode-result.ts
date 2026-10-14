import type { Result } from './result.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { MEDIA_LIMITS } from './github-media-limits.ts'
import { err, ok } from './result.ts'

export interface OpencodeResultLine {
  type: string
  sessionID: string
  part: Record<string, unknown>
}
// User file parts retain base64 media. Reserve that expansion plus bounded message overhead.
const maximumBytes = Math.ceil(MEDIA_LIMITS.totalBytes / 3) * 4 + 8 * 1024 * 1024
const maximumMessages = 1_024
const maximumParts = 4_096

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read only this turn's owned server. Never expose its auth or response in errors. */
interface ServerRead {
  url: string
  password: string
  workspace: string
  signal: AbortSignal
  fetch?: typeof fetch
}

/** MCP discovery is asynchronous. Admit Review only after its isolated server connects. */
export async function waitOpencodeReviewTools(input: ServerRead): Promise<Result<void, string>> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)])
  return (async (): Promise<Result<void, string>> => {
    while (!signal.aborted) {
      const result = await readOpencodeJson({
        ...input,
        signal,
        path: `/api/mcp?location[directory]=${encodeURIComponent(input.workspace)}`,
      })
      if (result._tag === 'Err') return result
      if (!record(result.value) || !Array.isArray(result.value.data))
        return err('The OpenCode Review tools returned an invalid catalog.')
      const server = result.value.data.find((entry: unknown) => record(entry) && entry.name === 'controller_review')
      if (record(server) && record(server.status)) {
        if (server.status.status === 'connected') {
          // V2 debounces MCP registry updates for 100 ms after discovery.
          await delay(250, undefined, { signal })
          return ok(undefined)
        }
        if (server.status.status !== 'pending') return err('The OpenCode Review tools failed to start.')
      }
      await delay(100, undefined, { signal })
    }
    return err('The OpenCode Review tools did not start within 15 seconds.')
  })().catch(() =>
    err(
      input.signal.aborted
        ? 'The OpenCode Review tools were cancelled.'
        : 'The OpenCode Review tools did not start within 15 seconds.',
    ),
  )
}

async function readOpencodeJson(
  input: ServerRead & { path: string; method?: string; body?: string },
): Promise<Result<unknown, string>> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)])
  return (async (): Promise<Result<unknown, string>> => {
    const response = await (input.fetch ?? fetch)(`${input.url}${input.path}`, {
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.body === undefined ? {} : { body: input.body }),
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${input.password}`).toString('base64')}`,
        'content-type': 'application/json',
      },
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
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > maximumBytes) return err('The OpenCode result read exceeded its byte limit.')
        chunks.push(chunk.value)
      }
      const text = Buffer.concat(chunks, bytes).toString('utf8')
      // Invalid JSON is a boundary failure, not an empty successful result.
      return Promise.resolve()
        .then(() => ok(JSON.parse(text) as unknown))
        .catch(() => err('The OpenCode result read returned invalid JSON.'))
    } finally {
      // Cancellation failures remain transport failures through the outer error boundary.
      await reader.cancel()
      reader.releaseLock()
    }
  })().catch(() =>
    err(input.signal.aborted ? 'The OpenCode result read was cancelled.' : 'The OpenCode result read failed.'),
  )
}

export async function readOpencodeMessages(
  input: ServerRead & { sessionId: string },
): Promise<Result<unknown, string>> {
  // V2 caps each page at 200. Follow its cursors while retaining the whole-turn limits.
  const data: unknown[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  let bytes = 0
  while (true) {
    const query = cursor === undefined ? 'order=asc' : `cursor=${encodeURIComponent(cursor)}`
    const page = await readOpencodeJson({
      ...input,
      path: `/api/session/${encodeURIComponent(input.sessionId)}/message?limit=200&${query}`,
    })
    if (page._tag === 'Err') return page
    if (!record(page.value) || !Array.isArray(page.value.data) || !record(page.value.cursor))
      return err('The OpenCode result returned an invalid message page.')
    bytes += Buffer.byteLength(JSON.stringify(page.value))
    data.push(...page.value.data)
    if (bytes > maximumBytes || data.length > maximumMessages)
      return err('The OpenCode result exceeded its message limits.')
    const next = page.value.cursor.next
    if (next == null) return ok({ data, cursor: { next: null } })
    if (typeof next !== 'string' || next === '' || cursors.has(next) || page.value.data.length === 0)
      return err('The OpenCode result returned an invalid message cursor.')
    cursors.add(next)
    cursor = next
  }
}

/** Start an empty session in the exact workspace, independent of CLI event delivery. */
export async function createOpencodeSession(
  input: ServerRead & { reviewTools?: readonly string[]; stateDirectory?: string },
): Promise<Result<string, string>> {
  const permissions =
    input.reviewTools === undefined
      ? [
          ...['question', 'plan_enter', 'plan_exit'].map((action) => ({ action, resource: '*', effect: 'deny' })),
          // The controller assigns this directory. An unattended session cannot answer a permission prompt.
          ...(input.stateDirectory === undefined
            ? []
            : [{ action: 'external_directory', resource: `${input.stateDirectory}/*`, effect: 'allow' }]),
        ]
      : [
          { action: '*', resource: '*', effect: 'deny' },
          ...input.reviewTools.map((action) => ({ action, resource: '*', effect: 'allow' })),
        ]
  const result = await readOpencodeJson({
    ...input,
    path: '/api/session',
    method: 'POST',
    body: JSON.stringify({ location: { directory: input.workspace }, permissions }),
  })
  if (result._tag === 'Err') return result
  if (
    !record(result.value) ||
    !record(result.value.data) ||
    typeof result.value.data.id !== 'string' ||
    !/^ses_[a-z\d]+$/i.test(result.value.data.id)
  )
    return err('The OpenCode server returned an invalid session identity.')
  return ok(result.value.data.id)
}

/** Stable content identity shared by the stream and persisted message recovery. */
export function opencodeDeliveryKey(type: string, part: Record<string, unknown>): string {
  return JSON.stringify([part.messageID, type, type === 'tool_use' ? part.id : type === 'step_finish' ? '' : part.text])
}

/** Recover only this fresh session's single user turn, including every completed assistant step. */
export function recoverOpencodeResult(
  value: unknown,
  sessionId: string,
  messageId: string | undefined,
  delivered: ReadonlySet<string>,
): Result<OpencodeResultLine[], string> {
  if (
    !record(value) ||
    !Array.isArray(value.data) ||
    !record(value.cursor) ||
    value.cursor.next != null ||
    value.data.length === 0 ||
    value.data.length > maximumMessages
  ) {
    return err('The OpenCode result has an invalid message count.')
  }
  const messages = value.data
  const identities = new Set<string>()
  const assistants: Array<Record<string, unknown> & { id: string; content: unknown[]; time: Record<string, unknown> }> =
    []
  let users = 0
  let idle = false
  let parts = 0
  for (const message of messages) {
    if (
      !record(message) ||
      typeof message.id !== 'string' ||
      identities.has(message.id) ||
      !record(message.time) ||
      typeof message.time.created !== 'number' ||
      !Number.isFinite(message.time.created)
    ) {
      return err('The OpenCode result message identity is invalid.')
    }
    identities.add(message.id)
    if (message.type === 'user') {
      users++
      if (assistants.length > 0) return err('The OpenCode result contains another user turn.')
    }
    if (message.type === 'idle') {
      if (message.outcome !== 'succeeded' || message.error !== undefined)
        return err('The OpenCode assistant did not complete its result.')
      idle = true
    }
    if (message.type !== 'assistant') continue
    if (
      idle ||
      message.error !== undefined ||
      !Array.isArray(message.content) ||
      typeof message.time.completed !== 'number' ||
      !Number.isFinite(message.time.completed)
    ) {
      return err('The OpenCode assistant identity is invalid.')
    }
    parts += message.content.length
    if (parts > maximumParts) return err('The OpenCode result exceeded its part limit.')
    assistants.push({ ...message, id: message.id, content: message.content, time: message.time })
  }
  if (
    users !== 1 ||
    assistants.length === 0 ||
    (messageId !== undefined && !assistants.some((message) => message.id === messageId))
  )
    return err('The OpenCode result does not contain its parent user message.')
  const last = assistants.at(-1)!
  if (
    !idle ||
    last.finish !== 'stop' ||
    !last.content.some(
      (part) => record(part) && part.type === 'text' && typeof part.text === 'string' && part.text.trim(),
    )
  )
    return err('The OpenCode result has no terminal answer.')
  const lines: OpencodeResultLine[] = []
  const append = (type: string, part: Record<string, unknown>) => {
    if (!delivered.has(opencodeDeliveryKey(type, part))) lines.push({ type, sessionID: sessionId, part })
  }
  for (const message of assistants) {
    const identity = { messageID: message.id, sessionID: sessionId }
    for (const item of message.content) {
      if (!record(item)) return err('The OpenCode result contains invalid content.')
      if (item.type === 'text' || item.type === 'reasoning') {
        if (typeof item.text !== 'string') return err('The OpenCode result contains unfinished text.')
        append(item.type, { ...identity, type: item.type, text: item.text })
      } else if (item.type === 'tool') {
        const state = item.state
        if (
          typeof item.id !== 'string' ||
          typeof item.name !== 'string' ||
          !record(state) ||
          !record(state.input) ||
          (state.status !== 'completed' && state.status !== 'error')
        ) {
          return err('The OpenCode result contains unfinished tool activity.')
        }
        if (state.status === 'error' && (!record(state.error) || typeof state.error.message !== 'string'))
          return err('The OpenCode result contains invalid tool activity.')
        if (
          state.status === 'completed' &&
          (!Array.isArray(state.content) ||
            state.content.length === 0 ||
            state.content.some((part) => !record(part) || (part.type === 'text' && typeof part.text !== 'string')))
        ) {
          return err('The OpenCode result contains invalid tool activity.')
        }
        const output = Array.isArray(state.content)
          ? state.content
              .filter((part) => record(part) && part.type === 'text')
              .map((part) => part.text)
              .join('\n')
          : ''
        append('tool_use', {
          ...identity,
          id: item.id,
          type: 'tool',
          tool: item.name,
          state: { ...state, output, error: record(state.error) ? state.error.message : undefined },
        })
      } else {
        return err('The OpenCode result contains unknown content.')
      }
    }
    const tokens = message.tokens
    if (
      !record(tokens) ||
      !record(tokens.cache) ||
      [tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write].some(
        (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0,
      )
    ) {
      return err('The OpenCode result contains invalid token usage.')
    }
    append('step_finish', { ...identity, type: 'step-finish', reason: message.finish, tokens })
  }
  return ok(lines)
}
