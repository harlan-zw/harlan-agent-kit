import type { ControllerContainer } from './controller.ts'
import type { SetupRecord } from './setup.ts'

/** One signed GitHub delivery waiting for the controller. */
export interface WebhookDelivery {
  delivery: string
  event: string
  signature: string
  /** The body itself, or the R2 key that holds it when the body is too large for a Queue message. */
  body: { _tag: 'Inline'; text: string } | { _tag: 'Stored'; key: string }
}

/** One delivery as the controller's webhook listener receives it. */
export interface RelayedDelivery {
  delivery: string
  event: string
  signature: string
  text: string
}

export interface Env {
  /** Comma separated GitHub owners, or owner/repository entries, the controller may act on. */
  ALLOWED_OWNERS: string
  /** `https://<team>.cloudflareaccess.com`. With ACCESS_AUD, every route but `/webhook` needs an Access sign-in. */
  ACCESS_TEAM_DOMAIN?: string
  /** The Application Audience (AUD) tag of the Access application. */
  ACCESS_AUD?: string
  CONTROLLER: DurableObjectNamespace<ControllerContainer>
  WEBHOOKS: Queue<WebhookDelivery>
  /** Large webhook bodies under `deliveries/`, and the controller's journal under `controller/`. */
  STATE: R2Bucket
  /** Agent worktree snapshots, one repository per GitHub repository. */
  ARTIFACTS: Artifacts
}

/** What the Worker asks of the controller's Durable Object. Tests stand in for it. */
export interface ControllerPort {
  readSetup: () => Promise<SetupRecord>
  writeSetup: (record: SetupRecord) => Promise<void>
  restart: (options: { forgetCodexLogin: boolean }) => Promise<void>
  /** Starts the controller when setup is complete. A no-op otherwise. */
  ensureRunning: () => Promise<void>
  /** The webhook listener's HTTP status, or null when setup is not complete. */
  relayWebhook: (delivery: RelayedDelivery) => Promise<number | null>
  /** One dashboard request, already translated to the controller's own origin. */
  proxyDashboard: (request: Request) => Promise<Response>
}
