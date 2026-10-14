import type { EdgeDependencies } from '../src/app.ts'
import type { ControllerPort, RelayedDelivery, WebhookDelivery } from '../src/env.ts'
import type { SetupRecord } from '../src/setup.ts'
import { EMPTY_SETUP } from '../src/setup.ts'

export const ORIGIN = 'https://agent.example.com'
export const WEBHOOK_SECRET = 'a-webhook-secret-of-at-least-32-characters'
export const DASHBOARD_PASSWORD = 'a-dashboard-password-of-at-least-32-bytes'

export async function sign(body: string, secret = WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  return `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export const READY_SETUP: SetupRecord = {
  ...EMPTY_SETUP,
  app: {
    id: 123,
    slug: 'wolfstar-project-agent-abcd',
    owner: 'wolfstar-project',
    htmlUrl: 'https://github.com/apps/wolfstar-project-agent-abcd',
    privateKey: '-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n',
    webhookSecret: WEBHOOK_SECRET,
    gitName: 'wolfstar-project-agent-abcd[bot]',
    gitEmail: '9+wolfstar-project-agent-abcd[bot]@users.noreply.github.com',
  },
  dashboardPassword: DASHBOARD_PASSWORD,
  providers: { claudeToken: 'sk-ant-oat01-token', codexAuth: null, zaiApiKey: null },
  issueCutoff: '2026-09-14',
}

export interface DashboardCall {
  url: string
  method: string
  headers: Headers
  body: string
}

export interface TestEdge {
  dependencies: EdgeDependencies
  setup: () => SetupRecord
  sent: WebhookDelivery[]
  objects: Map<string, string>
  relayed: RelayedDelivery[]
  dashboard: DashboardCall[]
  restarts: { forgetCodexLogin: boolean }[]
  github: { url: string; method: string }[]
}

export function createTestEdge(
  options: {
    setup?: SetupRecord
    relay?: (delivery: RelayedDelivery) => Promise<number | null>
    github?: (url: string, init?: RequestInit) => Promise<Response>
    now?: number
  } = {},
): TestEdge {
  let setup = structuredClone(options.setup ?? EMPTY_SETUP)
  const sent: WebhookDelivery[] = []
  const objects = new Map<string, string>()
  const relayed: RelayedDelivery[] = []
  const dashboard: DashboardCall[] = []
  const restarts: { forgetCodexLogin: boolean }[] = []
  const github: { url: string; method: string }[] = []

  const controller: ControllerPort = {
    readSetup: async () => structuredClone(setup),
    writeSetup: async (record) => {
      setup = structuredClone(record)
    },
    restart: async (restart) => {
      restarts.push(restart)
    },
    ensureRunning: async () => {},
    relayWebhook: async (delivery) => {
      relayed.push(delivery)
      return options.relay === undefined ? 204 : options.relay(delivery)
    },
    proxyDashboard: async (request) => {
      dashboard.push({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      })
      return new Response('dashboard')
    },
  }

  const dependencies = {
    controller,
    webhooks: {
      send: async (message: WebhookDelivery) => {
        sent.push(message)
      },
    },
    state: {
      put: async (key: string, value: string) => {
        objects.set(key, value)
      },
      get: async (key: string) => {
        const value = objects.get(key)
        return value === undefined ? null : { text: async () => value }
      },
      delete: async (key: string) => {
        objects.delete(key)
      },
    },
    allowedOwners: ['wolfstar-project'],
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      github.push({ url, method: init?.method ?? 'GET' })
      if (options.github === undefined) throw new Error(`Unexpected fetch: ${url}`)
      return options.github(url, init)
    },
    now: () => options.now ?? Date.parse('2026-10-14T12:00:00.000Z'),
  } as unknown as EdgeDependencies

  return { dependencies, setup: () => setup, sent, objects, relayed, dashboard, restarts, github }
}
