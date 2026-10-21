import type { AgentProvider, AgentRequest, AgentResponse, Result, TaskFailure, Usage } from './types.ts'

export interface OpenAICompatibleConfiguration {
  baseUrl: string
  model: string
  apiKey: string
  timeoutMs?: number
  maxResponseBytes?: number
  maxInputCharacters?: number
}

export interface ProviderFailure extends TaskFailure {
  code: 'configuration' | 'authentication' | 'quota' | 'transient' | 'timeout' | 'cancelled' | 'invalid-response'
  status?: number
  usage?: Usage
}

export interface HttpAgentProvider extends AgentProvider {
  generate: (request: AgentRequest) => Promise<Result<AgentResponse, ProviderFailure>>
}

export interface ProviderDependencies {
  fetch?: typeof fetch
  now?: () => Date
}

const fail = (error: ProviderFailure): Result<never, ProviderFailure> => ({ _tag: 'Err', error })
const success = <T>(value: T): Result<T, ProviderFailure> => ({ _tag: 'Ok', value })
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const positiveInteger = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max

function configurationError(message: string): Result<never, ProviderFailure> {
  return fail({ _tag: 'Configuration', code: 'configuration', message, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
}

function parseResponse(value: unknown, maxOutputTokens: number): Result<AgentResponse, ProviderFailure> {
  const usage = record(value) && record(value.usage) && positiveInteger(value.usage.prompt_tokens, 0, 100_000_000)
    && positiveInteger(value.usage.completion_tokens, 0, 100_000_000)
    ? { inputTokens: value.usage.prompt_tokens, outputTokens: value.usage.completion_tokens, costUsd: null }
    : null
  const invalid = () => fail({ _tag: 'Permanent', code: 'invalid-response', message: 'The agent provider returned an incomplete or invalid text response.', ...(usage ? { usage } : {}) })
  if (!record(value) || !Array.isArray(value.choices) || value.choices.length !== 1)
    return invalid()
  const choice: unknown = value.choices[0]
  if (!record(choice) || choice.finish_reason !== 'stop' || !record(choice.message))
    return invalid()
  const message = choice.message
  const hasTools = Array.isArray(message.tool_calls) ? message.tool_calls.length > 0 : message.tool_calls !== undefined && message.tool_calls !== null
  if (typeof message.content !== 'string' || hasTools || (message.function_call !== undefined && message.function_call !== null) || message.refusal)
    return invalid()
  if (!usage || usage.outputTokens > maxOutputTokens) {
    return invalid()
  }
  return success({
    text: message.content,
    usage,
  })
}

async function readBody(response: Response, maxBytes: number): Promise<Result<string, ProviderFailure>> {
  const tooLarge = () => fail({ _tag: 'Permanent', code: 'invalid-response', message: 'The agent provider response exceeds the response limit.' })
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel()
    return tooLarge()
  }
  if (!response.body)
    return success('')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done)
      break
    bytes += chunk.value.byteLength
    if (bytes > maxBytes) {
      await reader.cancel()
      return tooLarge()
    }
    chunks.push(chunk.value)
  }
  return success(Buffer.concat(chunks, bytes).toString('utf8'))
}

function statusFailure(response: Response, now: Date): ProviderFailure {
  const status = response.status
  if (status === 401 || status === 403)
    return { _tag: 'Authorization', code: 'authentication', status, message: 'The agent provider rejected its credentials or model access.', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }
  if (status === 429) {
    const header = response.headers.get('retry-after')
    const seconds = header === null ? Number.NaN : Number(header)
    const timestamp = header === null ? Number.NaN : Date.parse(header)
    const delay = Number.isFinite(seconds) ? seconds * 1000 : timestamp - now.getTime()
    const retryAt = new Date(now.getTime() + Math.min(86_400_000, Math.max(1000, Number.isFinite(delay) ? delay : 60_000))).toISOString()
    return { _tag: 'Capacity', code: 'quota', status, retryAt, message: 'The agent provider has no available quota or capacity.', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }
  }
  if (status === 408 || status === 409 || status >= 500)
    return { _tag: 'Transient', code: 'transient', status, message: `The agent provider is temporarily unavailable, HTTP ${status}.` }
  return { _tag: 'Configuration', code: 'configuration', status, message: `The agent provider rejected the configured request, HTTP ${status}.`, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }
}

/** A text-only transport. Repository content never becomes tools or executable instructions. */
export function createOpenAICompatibleProvider(configuration: OpenAICompatibleConfiguration, dependencies: ProviderDependencies = {}): Result<HttpAgentProvider, ProviderFailure> {
  if (typeof configuration.baseUrl !== 'string' || typeof configuration.model !== 'string' || !configuration.model.trim()
    || configuration.model.length > 200 || typeof configuration.apiKey !== 'string' || !configuration.apiKey.trim()
    || /[\r\n]/.test(configuration.apiKey)) {
    return configurationError('Configure an agent provider URL, model, and API key.')
  }
  const parsedUrl = (() => {
    try {
      return new URL(configuration.baseUrl)
    }
    catch {
      return null
    }
  })()
  if (!parsedUrl || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash
    || (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname)))) {
    return configurationError('Use an HTTPS agent provider URL. Local HTTP endpoints are allowed.')
  }
  const timeoutMs = configuration.timeoutMs ?? 120_000
  const maxResponseBytes = configuration.maxResponseBytes ?? 262_144
  const maxInputCharacters = configuration.maxInputCharacters ?? 262_144
  if (!positiveInteger(timeoutMs, 1, 900_000) || !positiveInteger(maxResponseBytes, 1024, 4_194_304)
    || !positiveInteger(maxInputCharacters, 1024, 1_048_576)) {
    return configurationError('Agent provider limits are outside their supported ranges.')
  }
  const url = `${parsedUrl.toString().replace(/\/$/, '')}/chat/completions`
  const transport = dependencies.fetch ?? fetch
  const now = dependencies.now ?? (() => new Date())
  return success({
    id: 'openai-compatible',
    async generate(request) {
      if (!positiveInteger(request.maxOutputTokens, 1, 32_768) || !Array.isArray(request.messages)
        || request.messages.length < 1 || request.messages.length > 64
        || request.messages.some(message => !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')
        || request.messages.reduce((total, message) => total + message.content.length, 0) > maxInputCharacters) {
        return configurationError('The agent turn exceeds the message or token limits.')
      }
      if (request.signal.aborted)
        return fail({ _tag: 'Permanent', code: 'cancelled', message: 'The agent turn was cancelled.', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
      const controller = new AbortController()
      const cancel = () => controller.abort(request.signal.reason)
      request.signal.addEventListener('abort', cancel, { once: true })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error('Agent provider timeout'))
      }, timeoutMs)
      timer.unref()
      const result = await (async (): Promise<Result<AgentResponse, ProviderFailure>> => {
        const response = await transport(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${configuration.apiKey}` },
          body: JSON.stringify({ model: configuration.model, messages: request.messages, max_completion_tokens: request.maxOutputTokens, stream: false, store: false }),
          redirect: 'error',
          credentials: 'omit',
          signal: controller.signal,
        })
        if (!response.ok) {
          await response.body?.cancel()
          return fail(statusFailure(response, now()))
        }
        const body = await readBody(response, maxResponseBytes)
        if (body._tag === 'Err')
          return body
        const parsed: unknown = (() => {
          try {
            return JSON.parse(body.value)
          }
          catch {
            return null
          }
        })()
        return parseResponse(parsed, request.maxOutputTokens)
      })().catch((): Result<AgentResponse, ProviderFailure> => {
        if (request.signal.aborted)
          return fail({ _tag: 'Permanent', code: 'cancelled', message: 'The agent turn was cancelled.' })
        if (timedOut)
          return fail({ _tag: 'Transient', code: 'timeout', message: 'The agent provider exceeded its time limit.' })
        return fail({ _tag: 'Transient', code: 'transient', message: 'The agent provider connection failed.' })
      })
      clearTimeout(timer)
      request.signal.removeEventListener('abort', cancel)
      return result
    },
  })
}
