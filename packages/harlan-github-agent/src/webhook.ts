import type { PackageReleaseCommand, PackageReleaseRequest } from './package-release.ts'
import type { ReviewCancellation } from './review-cancel.ts'
import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { H3 } from 'h3'
import { packageReleaseCommand, releaseRequest } from './package-release.ts'
import { reviewCancellation } from './review-cancel.ts'

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
  hint: (repository: string) => void
  stop: () => Promise<void>
}

export interface ReconcileHintOptions {
  /** How long to gather deliveries before reconciling, so a burst costs one pass. */
  delayMilliseconds?: number
  onError: (error: unknown) => void
  run: (repositories: readonly string[]) => Promise<void>
}

/**
 * Turns a burst of deliveries into one reconciliation.
 *
 * A busy repository can send a dozen deliveries in a second. Reconciling once
 * per delivery would spend the GitHub rate limit this feature exists to save,
 * so the first hint schedules a pass and every hint until it fires joins it.
 *
 * Keep the repository names so a delivery never refreshes unrelated repositories.
 * Deliveries received during a pass belong to the next pass.
 */
export function createReconcileHint(options: ReconcileHintOptions): ReconcileHint {
  const delayMilliseconds = options.delayMilliseconds ?? 3_000
  let state:
    | { _tag: 'Idle' }
    | { _tag: 'Scheduled', timer: NodeJS.Timeout }
    | { _tag: 'Running' }
    | { _tag: 'Stopped' } = { _tag: 'Idle' }
  let active: Promise<void> = Promise.resolve()
  const pending = new Set<string>()

  const schedule = (): void => {
    const timer = setTimeout(() => {
      state = { _tag: 'Running' }
      const repositories = [...pending]
      pending.clear()
      active = Promise.resolve().then(() => options.run(repositories)).catch(options.onError).finally(() => {
        if (state._tag !== 'Running')
          return
        state = { _tag: 'Idle' }
        if (pending.size > 0)
          schedule()
      })
    }, delayMilliseconds)
    timer.unref()
    state = { _tag: 'Scheduled', timer }
  }

  return {
    hint: (repository) => {
      if (state._tag === 'Stopped')
        return
      pending.add(repository)
      if (state._tag === 'Idle')
        schedule()
    },
    stop: async () => {
      if (state._tag === 'Scheduled')
        clearTimeout(state.timer)
      state = { _tag: 'Stopped' }
      pending.clear()
      await active
    },
  }
}

export interface WebhookAppOptions {
  allowedOwners: readonly string[]
  logger: { info: (message: string) => void }
  onHint: (repository: string) => void
  reviewCancellation?: {
    actorLogin: (repository: string) => string | null
    apply: (request: ReviewCancellation & { requestId: string }) => void
  }
  packageRelease?: {
    allowedAuthor: string
    actorLogin: (repository: string) => string | null
    apply: (request: PackageReleaseRequest & { requestId: string }) => void
    command?: (command: PackageReleaseCommand) => void
  }
  secret: string
  now?: () => number
}

/**
 * One listener that answers GitHub and nothing else.
 *
 * This app accepts signed Review cancellation and reconciliation hints. It runs on its own
 * port so that exposing it through a tunnel cannot reach the control API, which
 * can pause agents, approve pull requests, and eject sessions.
 */
export function createWebhookApp(options: WebhookAppOptions): H3 {
  const app = new H3()
  const deliveries = new Map<string, number>()
  const now = options.now ?? Date.now
  const retentionMilliseconds = 60 * 60_000
  const maximumDeliveries = 10_000

  app.get('/health', () => Response.json({ status: 'ok' }))

  app.post('/webhook', async (event) => {
    const body = await event.req.text()
    if (!verifyWebhookSignature(options.secret, body, event.req.headers.get('x-hub-signature-256'))) {
      // Never say which part failed. A precise answer is a probing oracle.
      return new Response('Signature mismatch.', { status: 401 })
    }

    const delivery = event.req.headers.get('x-github-delivery')
    if (delivery === null || delivery.trim() === '' || delivery.length > 128)
      return new Response('Delivery identity is missing or invalid.', { status: 400 })

    const at = now()
    for (const [id, expiresAt] of deliveries) {
      if (expiresAt > at)
        break
      deliveries.delete(id)
    }
    if (deliveries.has(delivery))
      return new Response(null, { status: 204 })

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
      const command = packageReleaseCommand(name, payload)
      if (command !== null && options.packageRelease !== undefined
        && command.requestedBy.toLowerCase() === options.packageRelease.allowedAuthor.toLowerCase()
        && options.packageRelease.actorLogin(hint.repository) !== null) {
        options.packageRelease.command?.(command)
      }
      const release = releaseRequest(name, payload)
      if (release !== null && options.packageRelease !== undefined
        && release.requestedBy.toLowerCase() === options.packageRelease.allowedAuthor.toLowerCase()
        && options.packageRelease.actorLogin(hint.repository)?.toLowerCase() === release.commentAuthor.toLowerCase()) {
        options.packageRelease.apply({ ...release, requestId: delivery })
      }
      const cancellation = reviewCancellation(name, payload)
      if (cancellation !== null
        && options.allowedOwners.some(author => author.toLowerCase() === cancellation.requestedBy.toLowerCase())
        && options.reviewCancellation?.actorLogin(hint.repository)?.toLowerCase() === cancellation.commentAuthor.toLowerCase()) {
        options.reviewCancellation.apply({ ...cancellation, requestId: delivery })
      }
      options.logger.info(`Webhook: ${name} on ${hint.repository}.`)
      options.onHint(hint.repository)
    }
    // Record only accepted deliveries. Polling recovers work after a restart.
    if (deliveries.size >= maximumDeliveries) {
      const oldest = deliveries.keys().next().value
      if (oldest !== undefined)
        deliveries.delete(oldest)
    }
    deliveries.set(delivery, at + retentionMilliseconds)
    // Acknowledge ignored events as well as scheduled reads.
    return new Response(null, { status: 204 })
  })

  return app
}
