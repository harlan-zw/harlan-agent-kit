import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { H3 } from 'h3'

/**
 * Events that change something this service acts on.
 *
 * Anything else is acknowledged and dropped. A narrow list keeps a noisy
 * installation from triggering a reconciliation for activity nobody reads.
 */
export const HINTED_WEBHOOK_EVENTS = new Set([
  'check_run',
  'check_suite',
  'issue_comment',
  'issues',
  'pull_request',
  'pull_request_review',
  'push',
  'status',
])

/**
 * Verifies one GitHub webhook signature.
 *
 * The comparison is constant time, and a signature of the wrong length is
 * rejected before the compare rather than throwing inside it.
 */
export function verifyWebhookSignature(secret: string, body: string, signature: string | null): boolean {
  if (signature === null || !signature.startsWith('sha256='))
    return false
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  const received = Buffer.from(signature)
  const computed = Buffer.from(expected)
  return received.length === computed.length && timingSafeEqual(received, computed)
}

/** What one delivery asks the service to do. */
export type WebhookHint
  = | { _tag: 'Reconcile', repository: string }
    | { _tag: 'Ignored', reason: string }

/**
 * Reads the repository one delivery is about.
 *
 * The payload is never stored and never trusted beyond this. A delivery is a
 * hint that says which repository to read again, so a forged or replayed body
 * can at worst ask the service to re-read GitHub, which it already does on a
 * timer.
 */
export function webhookHint(event: string, payload: unknown, allowedOwners: readonly string[]): WebhookHint {
  if (event === 'ping')
    return { _tag: 'Ignored', reason: 'ping' }
  if (!HINTED_WEBHOOK_EVENTS.has(event))
    return { _tag: 'Ignored', reason: `the ${event} event changes nothing this service reads` }

  const repository = typeof payload === 'object' && payload !== null
    ? (payload as { repository?: { full_name?: unknown } }).repository?.full_name
    : undefined
  if (typeof repository !== 'string' || !repository.includes('/'))
    return { _tag: 'Ignored', reason: 'the delivery names no repository' }

  const owner = repository.split('/')[0] ?? ''
  if (!allowedOwners.some(allowed => allowed.toLowerCase() === owner.toLowerCase()))
    return { _tag: 'Ignored', reason: `${owner} is not an allowed owner` }

  return { _tag: 'Reconcile', repository }
}

export interface ReconcileHint {
  hint: () => void
  stop: () => Promise<void>
}

export interface ReconcileHintOptions {
  /** How long to gather deliveries before reconciling, so a burst costs one pass. */
  delayMilliseconds?: number
  onError: (error: unknown) => void
  run: () => Promise<void>
}

/**
 * Turns a burst of deliveries into one reconciliation.
 *
 * A busy repository can send a dozen deliveries in a second. Reconciling once
 * per delivery would spend the GitHub rate limit this feature exists to save,
 * so the first hint schedules a pass and every hint until it fires joins it.
 *
 * Nothing here needs to know which repository moved. The pass reads every
 * enabled repository, which is what the poller already does, so a hint can
 * never leave the journal in a state a poll would not have reached anyway.
 */
export function createReconcileHint(options: ReconcileHintOptions): ReconcileHint {
  const delayMilliseconds = options.delayMilliseconds ?? 3_000
  let timer: NodeJS.Timeout | undefined
  let active: Promise<void> = Promise.resolve()
  let stopped = false

  return {
    hint: () => {
      if (stopped || timer !== undefined)
        return
      timer = setTimeout(() => {
        timer = undefined
        active = active.then(options.run).catch(options.onError)
      }, delayMilliseconds)
      timer.unref()
    },
    stop: async () => {
      stopped = true
      if (timer !== undefined)
        clearTimeout(timer)
      timer = undefined
      await active
    },
  }
}

export interface WebhookAppOptions {
  allowedOwners: readonly string[]
  logger: { info: (message: string) => void }
  onHint: (repository: string) => void
  secret: string
}

/**
 * One listener that answers GitHub and nothing else.
 *
 * This app carries no dashboard, no state, and no controls. It runs on its own
 * port so that exposing it through a tunnel cannot reach the control API, which
 * can pause agents, approve pull requests, and eject sessions.
 */
export function createWebhookApp(options: WebhookAppOptions): H3 {
  const app = new H3()

  app.get('/health', () => Response.json({ status: 'ok' }))

  app.post('/webhook', async (event) => {
    const body = await event.req.text()
    if (!verifyWebhookSignature(options.secret, body, event.req.headers.get('x-hub-signature-256'))) {
      // Never say which part failed. A precise answer is a probing oracle.
      return new Response('Signature mismatch.', { status: 401 })
    }

    const name = event.req.headers.get('x-github-event') ?? ''
    let payload: unknown
    try {
      payload = JSON.parse(body)
    }
    catch {
      return new Response('Body is not JSON.', { status: 400 })
    }

    const hint = webhookHint(name, payload, options.allowedOwners)
    if (hint._tag === 'Reconcile') {
      options.logger.info(`Webhook: ${name} on ${hint.repository}.`)
      options.onHint(hint.repository)
    }
    // Always 204. GitHub retries a failure, and a delivery this service chose
    // to ignore is not a failure it should send again.
    return new Response(null, { status: 204 })
  })

  return app
}
