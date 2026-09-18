// Typed Jev client over the Cloudflare AI /ai/run endpoint.
// Question and answer shapes mirror github.com/typesafe-ai/typesafe-sdk-js;
// the fork of pithings/advocaat replaced the transport.

/** A JSON-serializable value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** Text, a JSON object or array, or `null` for state, instructions, and criteria. */
export type Entry = string | Json[] | { [key: string]: Json } | null

// --- questions ---

/** A yes/no question answered with a probability. */
export interface NoulQuestion {
  type: 'noul'
  /** A question or statement to judge as true. */
  instructions?: Entry
  /** Optional descriptions of what counts as true or false. */
  criteria?: { true?: Entry, false?: Entry } | null
}

/** Option labels mapped to their descriptions; requires 2 to 255 options. */
export interface ChoiceCriteria { [label: string]: Entry }

/** A question that selects one labeled option. */
export interface ChoiceQuestion<T extends ChoiceCriteria = ChoiceCriteria> {
  type: 'choice'
  /** What to decide from the state. */
  instructions?: Entry
  /** 2 to 255 option labels and descriptions; both are sent to the model. */
  criteria: T
}

/** At least two descriptions indexed by score from zero. */
export type ScoreCriteria = readonly [Entry, Entry, ...Entry[]]

/** A question rated against 2 to 10 ordered score levels. */
export interface ScoreQuestion<T extends ScoreCriteria = ScoreCriteria> {
  type: 'score'
  /** What to rate in the state. */
  instructions?: Entry
  /** 2 to 10 level descriptions, numbered by array position from zero. */
  criteria: T
}

/** A supported evaluation question. */
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion

/** Named questions evaluated together against the same state. */
export interface Questions { [name: string]: Question }

export function noul(instructions: Entry = null, criteria?: NoulQuestion['criteria']): NoulQuestion {
  return {
    type: 'noul',
    instructions,
    ...(criteria === undefined ? {} : { criteria }),
  }
}

export function choice<const T extends ChoiceCriteria>(instructions: Entry, criteria: T): ChoiceQuestion<T> {
  return {
    type: 'choice',
    instructions,
    criteria,
  }
}

export function score<const T extends ScoreCriteria>(instructions: Entry, criteria: T): ScoreQuestion<T> {
  return {
    type: 'score',
    instructions,
    criteria,
  }
}

// --- answers ---

/** The probability that a yes/no question is true. */
export interface NoulAnswer {
  readonly type: 'noul'
  /** Probability of a yes answer, from zero to one. */
  readonly noul: number
}

/** The selected option and probability of each choice. */
export interface ChoiceAnswer<T extends ChoiceCriteria = ChoiceCriteria> {
  readonly type: 'choice'
  /** The label of the highest-probability option. */
  readonly choice: keyof T & string
  /** How much the top option stands out, from zero to one. */
  readonly confidence: number
  /** Probability of each option, keyed by its label. */
  readonly probabilities: { readonly [label in keyof T]: number }
}

/** Score keys inferred from the rubric; a fixed-length tuple yields its indices, otherwise `number`. */
export type ScoreOf<T extends ScoreCriteria> = number extends T['length']
  ? number
  : Extract<keyof T, `${number}`>

/** The expected score, rubric, and probability of each level. */
export interface ScoreAnswer<T extends ScoreCriteria = ScoreCriteria> {
  readonly type: 'score'
  /** Sum of each level number times its probability; may fall between levels. */
  readonly score: number
  /** How much the top level stands out, from zero to one. */
  readonly confidence: number
  /** Level descriptions keyed by zero-based level number, e.g. { "0": "Calm" }. */
  readonly legend: { readonly [score in ScoreOf<T>]: T[score] }
  /** Probability of each level, keyed by level number. */
  readonly probabilities: { readonly [score in ScoreOf<T>]: number }
}

/** The answer type inferred from a question and its criteria. */
export type AnswerFor<T extends Question> = T extends NoulQuestion
  ? NoulAnswer
  : T extends ScoreQuestion<infer S>
    ? ScoreAnswer<S>
    : T extends ChoiceQuestion<infer C>
      ? ChoiceAnswer<C>
      : never

/** Shared state and questions, with an optional model override. */
export interface SystemOneRequest<Q extends Questions = Questions> {
  /** Content to evaluate, shared by all questions. */
  state: Entry
  /** Questions keyed by your own names; these names are not sent to the model. */
  questions: Q
  /** Overrides the client's default model for this request. */
  model?: string
}

/** Answers keyed by question name, with the model used and token usage. */
export interface SystemOneResult<Q extends Questions> {
  /** The model used for this evaluation. */
  readonly model: string
  /** Answers under the same keys as the request's questions. */
  readonly answers: { readonly [K in keyof Q]: AnswerFor<Q[K]> }
  /** Token counts; missing counts default to zero. */
  readonly usage: { readonly input_tokens: number, readonly output_tokens: number }
}

// --- client ---

const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4'
const DEFAULT_MODEL = 'typesafe/jev'

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
  const baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = options.model ?? DEFAULT_MODEL
  const retries = options.retries ?? 2
  const gatewayId = options.gatewayId ?? env('CLOUDFLARE_AI_GATEWAY_ID')
  const fetch = options.fetch ?? globalThis.fetch
  const url = `${baseURL}/accounts/${accountId}/ai/run`

  async function attempt(
    body: string,
    init: RequestOptions,
    headers: Record<string, string>,
  ): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      ...(init.signal === undefined ? {} : { signal: init.signal }),
      headers: { ...headers, ...init.headers },
      body,
    })
  }

  return {
    /** Evaluates every question against the shared state in one request. */
    systemOne<const Q extends Questions>(req: SystemOneRequest<Q>, init: RequestOptions = {}): Promise<SystemOneResult<Q>> {
      if (Object.keys(req.questions).length === 0)
        throw new TypeError('At least one question is required.')
      for (const [name, q] of Object.entries(req.questions)) {
        if (q.type === 'score' && !within(q.criteria, 2, 10))
          throw new TypeError(`Score question "${name}" needs 2 to 10 levels.`)
        if (q.type === 'choice' && !within(Object.keys(q.criteria ?? {}), 2, 255))
          throw new TypeError(`Choice question "${name}" needs 2 to 255 options.`)
      }
      return send(req, init)
    },
  }

  async function send<Q extends Questions>(req: SystemOneRequest<Q>, init: RequestOptions): Promise<SystemOneResult<Q>> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(gatewayId === undefined ? {} : { 'cf-aig-gateway-id': gatewayId }),
    }
    const body = JSON.stringify({
      model: req.model ?? model,
      input: { state: req.state, questions: req.questions },
    })

    let res = await attempt(body, init, headers)
    for (let attempted = 0; (res.status === 429 || res.status === 529) && attempted < retries; attempted++) {
      await sleep(backoffMilliseconds(res, attempted), init.signal)
      res = await attempt(body, init, headers)
    }
    const parsed = await parse(res)
    if (!res.ok)
      throw new APIError(res.status, parsed, res.headers.get('cf-ray') ?? '')
    const result = unwrap(parsed, res)
    return result as SystemOneResult<Q>
  }
}

/** A client for evaluating questions against Jev. */
export type JevClient = ReturnType<typeof jev>

function within(list: unknown, min: number, max: number) {
  return Array.isArray(list) && list.length >= min && list.length <= max
}

// Cloudflare answers REST calls with `{ success, errors, result }` on failure
// and sometimes wraps success. Jev itself answers with the System One result.
function unwrap(parsed: unknown, res: Response): unknown {
  if (typeof parsed !== 'object' || parsed === null || !('success' in parsed))
    return parsed
  const envelope = parsed as { success: boolean, errors?: unknown, result?: unknown }
  if (!envelope.success)
    throw new APIError(res.status, envelope.errors ?? parsed, res.headers.get('cf-ray') ?? '')
  return 'result' in envelope ? envelope.result : parsed
}

function backoffMilliseconds(res: Response, attempted: number): number {
  const retryAfter = res.headers.get('retry-after')
  if (retryAfter !== null && Number.isFinite(Number(retryAfter)))
    return Math.max(0, Number(retryAfter)) * 1000
  return 500 * 2 ** attempted
}

// A sleep that ends early when the caller cancels, so a retried request
// cannot outlive its own signal.
function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(new DOMException('The classification request was cancelled.', 'AbortError'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('The classification request was cancelled.', 'AbortError'))
    }, { once: true })
  })
}

// Optional: only runtimes with a Node-style `process.env` provide values. Blank values count as unset.
function env(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } }
  return g.process?.env?.[name]?.trim() || undefined
}

// Servers and proxies don't always set content-type, so always try JSON first.
async function parse(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text)
    return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
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
