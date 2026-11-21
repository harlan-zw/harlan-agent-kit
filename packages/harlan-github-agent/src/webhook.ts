import type { LoggedFindingPickup } from './logged-finding-pickup.ts'
import type { PackageReleaseCommand, PackageReleaseRequest, ReleaseNoteApproval } from './package-release.ts'
import type { Result } from './result.ts'
import type { ReviewApproval } from './review-approval.ts'
import type { ReviewCancellation } from './review-cancel.ts'
import type { ReviewCheckRerun } from './review-check-rerun.ts'
import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { H3 } from 'h3'
import { loggedFindingPickup } from './logged-finding-pickup.ts'
import { packageReleaseCommand, releaseNoteApproval, releaseRequest } from './package-release.ts'
import { isAllowedRepository } from './repository-discovery.ts'
import { reviewApproval } from './review-approval.ts'
import { reviewCancellation } from './review-cancel.ts'
import { reviewCheckRerun } from './review-check-rerun.ts'

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
  // A reply on a finding thread asks for a fresh Review.
  'pull_request_review_comment',
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

  if (!isAllowedRepository(repository, allowedOwners))
    return { _tag: 'Ignored', reason: `${repository} is outside the allowed repository scope` }

  return { _tag: 'Reconcile', repository }
}

/** One accepted delivery, as the Timeline records it. Nothing else of the payload is kept. */
export interface DeliveryRecord {
  at: number
  /** The repository the delivery names inside the allowed scope, or null. */
  repository: string | null
  event: string
  /** The payload `action`, or an empty string when the event has none, such as `push`. */
  action: string
  /** A check run or check suite that this Service's own GitHub App created. */
  ownCheck: boolean
  /** The issue or pull request this delivery asks the Service to act on, or null. */
  workItem: number | null
}

/** Deliveries that start or change Agent work on one item. Comments count only as a command. */
const WORK_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  pull_request: new Set(['opened', 'synchronize', 'closed']),
  issues: new Set(['opened']),
}

const deliveryName = /^[a-z_]{1,64}$/

function field(value: unknown, ...path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null)
      return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function itemNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * Reads what the Timeline keeps of one accepted delivery: its repository
 * inside the allowed scope, event, action, and minute, whether the Service's
 * own App sent the check, and which item it moves. `command` says the
 * delivery ran an authorized comment command.
 */
export function deliveryRecord(input: { event: string, payload: unknown, at: number, allowedOwners: readonly string[], appId: number | null, command: boolean }): DeliveryRecord {
  const event = deliveryName.test(input.event) ? input.event : 'unknown'
  const rawAction = field(input.payload, 'action')
  const action = typeof rawAction === 'string' && deliveryName.test(rawAction) ? rawAction : ''
  const named = field(input.payload, 'repository', 'full_name')
  const repository = typeof named === 'string' && named.includes('/') && isAllowedRepository(named, input.allowedOwners) ? named : null
  const checkApp = event === 'check_run' || event === 'check_suite' ? field(input.payload, event, 'app', 'id') : undefined
  const ownCheck = input.appId !== null && checkApp === input.appId
  const works = repository !== null && (WORK_ACTIONS[event]?.has(action) === true || (event === 'issue_comment' && input.command))
  const workItem = !works
    ? null
    : event === 'pull_request'
      ? itemNumber(field(input.payload, 'pull_request', 'number') ?? field(input.payload, 'number'))
      : itemNumber(field(input.payload, 'issue', 'number'))
  return { at: input.at, repository, event, action, ownCheck, workItem }
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
  onHint: (repository: string, event: string) => void
  reviewApproval?: {
    allowedAuthor: string
    actorLogin: (repository: string) => string | null
    apply: (request: ReviewApproval & { requestId: string }) => Promise<Result<void, string>>
  }
  reviewCancellation?: {
    actorLogin: (repository: string) => string | null
    apply: (request: ReviewCancellation & { requestId: string }) => void
  }
  /** `appId` returns null where this service publishes no Review check run. */
  reviewCheckRerun?: {
    allowedAuthor: string
    appId: (repository: string) => number | null
    apply: (request: ReviewCheckRerun & { requestId: string }) => void
  }
  packageRelease?: {
    allowedAuthor: string
    actorLogin: (repository: string) => string | null
    apply: (request: PackageReleaseRequest & { requestId: string }) => void
    command?: (command: PackageReleaseCommand) => void
    /** Harlan ticked the apply control below a Release note draft. */
    approveNote?: (request: ReleaseNoteApproval & { requestId: string }) => void
  }
  loggedFindingPickup?: {
    allowedAuthor: string
    actorLogin: (repository: string) => string | null
    apply: (request: LoggedFindingPickup & { requestId: string }) => void | Promise<Result<void, string>>
  }
  secret: string
  now?: () => number
  /** This Service's GitHub App, so its own check deliveries can be told apart. */
  appId?: number
  /** Keeps one accepted delivery for the Timeline. A failure is logged and never refuses the delivery. */
  recordDelivery?: (delivery: DeliveryRecord) => void
}

/**
 * One listener that answers GitHub and nothing else.
 *
 * This app accepts signed Review cancellation and reconciliation hints. It runs on its own
 * port so that exposing it through a tunnel cannot reach the control API, which
 * can pause agents, approve pull requests, and cancel Tasks.
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
    let commanded = false
    if (hint._tag === 'Reconcile') {
      const command = packageReleaseCommand(name, payload)
      if (command !== null && options.packageRelease !== undefined
        && command.requestedBy.toLowerCase() === options.packageRelease.allowedAuthor.toLowerCase()
        && options.packageRelease.actorLogin(hint.repository) !== null) {
        options.packageRelease.command?.(command)
        commanded = true
      }
      const release = releaseRequest(name, payload)
      if (release !== null && options.packageRelease !== undefined
        && release.requestedBy.toLowerCase() === options.packageRelease.allowedAuthor.toLowerCase()
        && options.packageRelease.actorLogin(hint.repository)?.toLowerCase() === release.commentAuthor.toLowerCase()) {
        options.packageRelease.apply({ ...release, requestId: delivery })
        commanded = true
      }
      const noteApproval = releaseNoteApproval(name, payload)
      if (noteApproval !== null && options.packageRelease?.approveNote !== undefined
        && noteApproval.requestedBy.toLowerCase() === options.packageRelease.allowedAuthor.toLowerCase()
        && options.packageRelease.actorLogin(hint.repository)?.toLowerCase() === noteApproval.commentAuthor.toLowerCase()) {
        options.packageRelease.approveNote({ ...noteApproval, requestId: delivery })
        commanded = true
      }
      const pickup = loggedFindingPickup(name, payload)
      if (pickup !== null && options.loggedFindingPickup !== undefined
        && pickup.requestedBy.toLowerCase() === options.loggedFindingPickup.allowedAuthor.toLowerCase()
        && options.loggedFindingPickup.actorLogin(hint.repository)?.toLowerCase() === pickup.commentAuthor.toLowerCase()) {
        const applied = await options.loggedFindingPickup.apply({ ...pickup, requestId: delivery })
        if (applied?._tag === 'Err') {
          options.logger.info(`Finding selection failed: ${applied.error}`)
          return new Response('Finding selection failed. Retry this delivery.', { status: 503 })
        }
        commanded = true
      }
      const approval = reviewApproval(name, payload)
      if (approval !== null && options.reviewApproval !== undefined
        && approval.requestedBy.toLowerCase() === options.reviewApproval.allowedAuthor.toLowerCase()
        && options.reviewApproval.actorLogin(hint.repository)?.toLowerCase() === approval.commentAuthor.toLowerCase()) {
        const applied = await options.reviewApproval.apply({ ...approval, requestId: delivery })
        if (applied._tag === 'Err') {
          options.logger.info(`Review Approval failed: ${applied.error}`)
          return new Response('Review Approval failed. Retry this delivery.', { status: 503 })
        }
        commanded = true
      }
      const cancellation = reviewCancellation(name, payload)
      if (cancellation !== null
        && options.allowedOwners.some(author => author.toLowerCase() === cancellation.requestedBy.toLowerCase())
        && options.reviewCancellation?.actorLogin(hint.repository)?.toLowerCase() === cancellation.commentAuthor.toLowerCase()) {
        options.reviewCancellation.apply({ ...cancellation, requestId: delivery })
        commanded = true
      }
      const rerun = reviewCheckRerun(name, payload)
      if (rerun !== null && options.reviewCheckRerun !== undefined
        && rerun.requestedBy.toLowerCase() === options.reviewCheckRerun.allowedAuthor.toLowerCase()
        && options.reviewCheckRerun.appId(hint.repository) === rerun.appId) {
        options.reviewCheckRerun.apply({ ...rerun, requestId: delivery })
      }
      options.logger.info(`Webhook: ${name} on ${hint.repository}.`)
      options.onHint(hint.repository, name)
    }
    // Record only accepted deliveries. Polling recovers work after a restart.
    if (deliveries.size >= maximumDeliveries) {
      const oldest = deliveries.keys().next().value
      if (oldest !== undefined)
        deliveries.delete(oldest)
    }
    deliveries.set(delivery, at + retentionMilliseconds)
    if (options.recordDelivery !== undefined) {
      try {
        options.recordDelivery(deliveryRecord({ event: name, payload, at, allowedOwners: options.allowedOwners, appId: options.appId ?? null, command: commanded }))
      }
      catch (error) {
        // The Timeline loses one count. The delivery itself already did its work.
        options.logger.info(`Delivery recording failed: ${error instanceof Error ? error.message : 'unknown error'}`)
      }
    }
    // Acknowledge ignored events as well as scheduled reads.
    return new Response(null, { status: 204 })
  })

  return app
}
