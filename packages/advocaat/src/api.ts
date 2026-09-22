// Typed Jev client over the Cloudflare AI /ai/run endpoint.
// The transport, question shapes, and answer validation live in @harlan-zw/jev.
// This module is the throwing surface the agent stack consumes: `systemOne`
// resolves a SystemOneResult or throws, and question limits throw a TypeError
// before any request is sent.

import type { JevFailure, JevResult, Questions, SystemOneRequest, SystemOneResult } from '@harlan-zw/jev'
import { createJevHttpClient } from '@harlan-zw/jev'

export { choice, noul, score } from '@harlan-zw/jev'
export type {
  AnswerFor,
  ChoiceAnswer,
  ChoiceCriteria,
  ChoiceQuestion,
  Entry,
  Json,
  NoulAnswer,
  NoulQuestion,
  Question,
  Questions,
  ScoreAnswer,
  ScoreCriteria,
  ScoreOf,
  ScoreQuestion,
  SystemOneRequest,
  SystemOneResult,
} from '@harlan-zw/jev'

/**
 * Explicit options win over `CLOUDFLARE_*` environment variables, then
 * defaults.
 */
export interface JevOptions {
  /** Env: `CLOUDFLARE_ACCOUNT_ID`. */
  accountId?: string
  /** Env: `CLOUDFLARE_API_TOKEN`. Needs `Account > Workers AI > Read`. */
  apiToken?: string
  /** Routes through this named AI Gateway instead of the account default. Env: `CLOUDFLARE_AI_GATEWAY_ID`. */
  gatewayId?: string
  /** Default: `typesafe/jev`. */
  model?: string
  /** Extra attempts after HTTP 429 and 529. Default `2`. */
  retries?: number
  /** Custom fetch implementation; defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch
  /** Overrides the API base URL. Tests use this. */
  baseURL?: string
  /** Request window in milliseconds. Default: the shared client's 8 seconds. */
  timeoutMs?: number
}

/** Per-request cancellation and additional HTTP headers. */
export interface RequestOptions {
  /** Cancels the underlying fetch request. */
  signal?: AbortSignal
  /** Additional headers; the client sets authorization and JSON content headers. */
  headers?: Record<string, string>
}

/** A non-2xx response, or a 2xx response Cloudflare marked failed. */
export class APIError extends Error {
  override name = 'APIError'
  /** HTTP response status. */
  status: number
  /** Response body parsed as JSON, or text if parsing fails; undefined if empty. */
  body: unknown
  /** Cloudflare ray identifier from response headers, or an empty string. */
  requestId: string
  constructor(status: number, body: unknown, requestId = '') {
    super(`${status} ${describe(body)}`)
    this.status = status
    this.body = body
    this.requestId = requestId
  }
}

/** A client for evaluating questions against Jev through Cloudflare. */
export function jev(options: JevOptions = {}) {
  const accountId = options.accountId ?? env('CLOUDFLARE_ACCOUNT_ID')
  const apiToken = options.apiToken ?? env('CLOUDFLARE_API_TOKEN')
  if (accountId === undefined || apiToken === undefined) {
    throw new TypeError(
      'Pass accountId and apiToken to jev() or set the CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables.',
    )
  }
  const gatewayId = options.gatewayId ?? env('CLOUDFLARE_AI_GATEWAY_ID')

  return {
    /** Evaluates every question against the shared state in one request. */
    systemOne<const Q extends Questions>(req: SystemOneRequest<Q>, init: RequestOptions = {}): Promise<SystemOneResult<Q>> {
      validateQuestions(req.questions)
      const signal = init.signal
      // A pre-aborted signal must reject before the client exists: invoking it
      // would send the request and leave its promise orphaned, so a later
      // failure of that request would surface as an unhandled rejection.
      if (signal?.aborted)
        return Promise.reject(cancelled())
      // One client per call, so per-request headers reach its fetcher. The
      // client is pure configuration, so this costs nothing.
      const client = createJevHttpClient({
        accountId,
        apiToken,
        ...(gatewayId === undefined ? {} : { gatewayId }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.retries === undefined ? {} : { retries: options.retries }),
        ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        fetcher: fetcher(options.fetch, init.headers, signal),
      })
      const sent: Promise<SystemOneResult<Q>> = client.systemOne(req).then(throwOnFailure)
      if (signal === undefined)
        return sent
      return new Promise<SystemOneResult<Q>>((resolve, reject) => {
        const abort = () => reject(cancelled())
        signal.addEventListener('abort', abort, { once: true })
        sent.then(
          (result) => {
            signal.removeEventListener('abort', abort)
            resolve(result)
          },
          (error: unknown) => {
            signal.removeEventListener('abort', abort)
            reject(error)
          },
        )
      })
    },
  }
}

/** A client for evaluating questions against Jev. */
export type JevClient = ReturnType<typeof jev>

// The shared client reports failures as values. This is the one place they
// become throws again, so the stack's catch paths keep working.
function throwOnFailure<Q extends Questions>(result: JevResult<Q>): SystemOneResult<Q> {
  if (result._tag === 'Ok')
    return result.result
  throw failureToError(result.failure)
}

function failureToError(failure: JevFailure): Error {
  if (failure._tag === 'Http')
    return new APIError(failure.status, failure.details, failure.requestId ?? '')
  if (failure._tag === 'Invalid') {
    // A 2xx body Cloudflare marked failed keeps its wire provenance: the raw
    // body and the ray travel on the error, not just inside its message.
    return new APIError(
      200,
      {
        error: failure.message,
        ...(failure.body === undefined ? {} : { body: failure.body }),
        ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
      },
      failure.requestId ?? '',
    )
  }
  // The shared client folds an expired request window into Timeout. It
  // surfaces as TimeoutError, so a caller records a service failure, never an
  // operator cancellation: a caller abort travels on the signal instead and
  // rejects above as AbortError.
  if (failure._tag === 'Timeout')
    return new DOMException(failure.message, 'TimeoutError')
  return new Error(failure.message)
}

function cancelled(): DOMException {
  return new DOMException('The classification request was cancelled.', 'AbortError')
}

// The shared client answers invalid questions with a failure value; the
// throwing surface rejects them before any request is sent.
function validateQuestions(questions: Questions): void {
  if (Object.keys(questions).length === 0)
    throw new TypeError('At least one question is required.')
  for (const [name, q] of Object.entries(questions)) {
    if (q.type === 'score' && !within(q.criteria, 2, 10))
      throw new TypeError(`Score question "${name}" needs 2 to 10 levels.`)
    if (q.type === 'choice' && !within(Object.keys(q.criteria ?? {}), 2, 255))
      throw new TypeError(`Choice question "${name}" needs 2 to 255 options.`)
  }
}

function within(list: unknown, min: number, max: number) {
  return Array.isArray(list) && list.length >= min && list.length <= max
}

function fetcher(
  fetch: typeof globalThis.fetch | undefined,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
) {
  const base = fetch ?? globalThis.fetch
  if (headers === undefined && signal === undefined)
    return (input: string | URL | Request, init?: RequestInit) => base(input, init)
  return (input: string | URL | Request, init?: RequestInit) => {
    const merged = wireSignal(init?.signal, signal)
    return base(input, {
      ...init,
      // The client passes its own deadline signal. A caller's abort must
      // cancel the request on the wire, not just stop the caller waiting,
      // so both signals share one abort.
      ...(merged === undefined ? {} : { signal: merged }),
      ...(headers === undefined
        ? {}
        : { headers: { ...(init?.headers as Record<string, string> | undefined), ...headers } }),
    })
  }
}

function wireSignal(deadline: AbortSignal | null | undefined, caller: AbortSignal | undefined): AbortSignal | undefined {
  if (caller === undefined)
    return deadline ?? undefined
  if (deadline === undefined || deadline === null)
    return caller
  return AbortSignal.any([deadline, caller])
}

// Optional: only runtimes with a Node-style `process.env` provide values. Blank values count as unset.
function env(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } }
  return g.process?.env?.[name]?.trim() || undefined
}

function describe(body: unknown): string {
  if (typeof body === 'string')
    return body
  if (typeof body !== 'object' || body === null)
    return '(no body)'
  const { error, message, detail } = body as Record<string, unknown>
  const m = error ?? message ?? detail
  if (typeof m === 'string')
    return m
  if (
    typeof m === 'object'
    && m !== null
    && typeof (m as { message?: unknown }).message === 'string'
  ) {
    return (m as { message: string }).message
  }
  return JSON.stringify(body).slice(0, 200)
}
