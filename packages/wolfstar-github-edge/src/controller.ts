import type { OutboundHandler } from '@cloudflare/containers'
import type { Env, RelayedDelivery } from './env.ts'
import type { SetupRecord } from './setup.ts'
import { Container } from '@cloudflare/containers'
import { EMPTY_SETUP, isReady } from './setup.ts'

const SETUP_KEY = 'setup'
const DASHBOARD_PORT = 8080
const WEBHOOK_PORT = 8081
/** Files the Container may keep in R2 through `http://state.internal/files/<name>`. */
const STATE_FILES = new Set(['state.sqlite', 'codex-auth.json'])

/**
 * Lets the Container read and write its journal in R2 without a credential.
 *
 * This handler runs in the Workers runtime, so the Container only sees a
 * plain HTTP hostname and never the bucket.
 */
const stateFiles: OutboundHandler<Env> = async (request, env) => {
  const name = new URL(request.url).pathname.replace(/^\/files\//, '')
  if (!STATE_FILES.has(name)) return new Response('Not found.', { status: 404 })
  const key = `controller/${name}`
  if (request.method === 'GET') {
    const object = await env.STATE.get(key)
    return object === null ? new Response('Not found.', { status: 404 }) : new Response(object.body)
  }
  if (request.method === 'PUT') {
    await env.STATE.put(key, request.body)
    return new Response(null, { status: 204 })
  }
  return new Response('Method not allowed.', { status: 405 })
}

/**
 * The controller, one Container behind one Durable Object.
 *
 * The Durable Object also keeps the setup record: the GitHub App, the
 * dashboard password, and the Agent provider logins. They reach the
 * Container as environment variables when it starts, and nowhere else.
 */
export class ControllerContainer extends Container<Env> {
  override defaultPort = DASHBOARD_PORT
  override requiredPorts = [DASHBOARD_PORT, WEBHOOK_PORT]
  override sleepAfter = '1h'
  override enableInternet = true

  static {
    this.outboundByHost = { 'state.internal': stateFiles as OutboundHandler }
  }

  /** The controller polls GitHub and runs Routines on its own clock, so it never sleeps. */
  override async onActivityExpired(): Promise<void> {
    this.renewActivityTimeout()
  }

  async readSetup(): Promise<SetupRecord> {
    const stored = await this.ctx.storage.get<SetupRecord>(SETUP_KEY)
    // A record saved before a provider existed lacks its field, so the defaults fill it.
    return { ...EMPTY_SETUP, ...stored, providers: { ...EMPTY_SETUP.providers, ...stored?.providers } }
  }

  async writeSetup(record: SetupRecord): Promise<void> {
    await this.ctx.storage.put(SETUP_KEY, record)
  }

  /** Loads the start environment from the setup record. False until setup is complete. */
  private async prepare(): Promise<boolean> {
    const record = await this.readSetup()
    if (!isReady(record)) return false
    this.envVars = controllerEnvironment(record, this.env.ALLOWED_OWNERS)
    return true
  }

  async ensureRunning(): Promise<void> {
    if (!(await this.prepare())) return
    await this.startAndWaitForPorts({ ports: [DASHBOARD_PORT, WEBHOOK_PORT] })
  }

  async restart(options: { forgetCodexLogin: boolean }): Promise<void> {
    // A new Codex login replaces the one the Container saved, which would otherwise win.
    if (options.forgetCodexLogin) await this.env.STATE.delete('controller/codex-auth.json')
    const state = await this.getState()
    if (state.status === 'running' || state.status === 'healthy') {
      // SIGTERM lets the Container back up its journal before it exits.
      await this.stop('SIGTERM')
    }
    // The old Container may still be stopping. The next request or the cron starts it then.
    await this.ensureRunning().catch((error: unknown) => console.warn('The controller did not start yet.', error))
  }

  async relayWebhook(delivery: RelayedDelivery): Promise<number | null> {
    if (!(await this.prepare())) return null
    const response = await this.containerFetch(
      new Request('http://127.0.0.1/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-delivery': delivery.delivery,
          'x-github-event': delivery.event,
          'x-hub-signature-256': delivery.signature,
        },
        body: delivery.text,
      }),
      WEBHOOK_PORT,
    )
    await response.body?.cancel()
    return response.status
  }

  async proxyDashboard(request: Request): Promise<Response> {
    if (!(await this.prepare())) return new Response('Setup is not complete.', { status: 503 })
    return this.containerFetch(request, DASHBOARD_PORT)
  }
}

/** The variables the Container start reads. Keep in step with `RUNTIME_VARIABLES` in the agent package. */
export function controllerEnvironment(record: SetupRecord, allowedOwners: string): Record<string, string> {
  const app = record.app!
  return {
    WOLFSTAR_GITHUB_APP_ID: String(app.id),
    WOLFSTAR_GITHUB_APP_SLUG: app.slug,
    WOLFSTAR_GITHUB_APP_PRIVATE_KEY: app.privateKey,
    WOLFSTAR_GITHUB_WEBHOOK_SECRET: app.webhookSecret,
    WOLFSTAR_DASHBOARD_PASSWORD: record.dashboardPassword ?? '',
    WOLFSTAR_ALLOWED_OWNERS: allowedOwners,
    WOLFSTAR_GIT_NAME: app.gitName,
    WOLFSTAR_GIT_EMAIL: app.gitEmail,
    WOLFSTAR_MUTATIONS_ENABLED: String(record.mutationsEnabled),
    WOLFSTAR_ISSUE_CUTOFF: record.issueCutoff ?? new Date().toISOString().slice(0, 10),
    CLAUDE_CODE_OAUTH_TOKEN: record.providers.claudeToken ?? '',
    WOLFSTAR_CODEX_AUTH_JSON: record.providers.codexAuth ?? '',
    WOLFSTAR_ZAI_API_KEY: record.providers.zaiApiKey ?? '',
    WOLFSTAR_WORKERS_AI_TOKEN: record.providers.workersAiToken ?? '',
    WOLFSTAR_WORKERS_AI_ACCOUNT_ID: record.providers.workersAiAccountId ?? '',
    WOLFSTAR_GITHUB_USER_TOKEN: record.githubUser?.token ?? '',
  }
}
