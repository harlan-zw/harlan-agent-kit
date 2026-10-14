import type { ControllerPort, Env, WebhookDelivery } from './env.ts'
import { ContainerProxy } from '@cloudflare/containers'
import { accessSettings } from './access.ts'
import { handleQueue, handleRequest, parseAllowedOwners } from './app.ts'
import { ControllerContainer } from './controller.ts'

export { ContainerProxy, ControllerContainer }
export type { Env, WebhookDelivery } from './env.ts'

/** There is one controller. Every request reaches the same Durable Object. */
function controller(env: Env): ControllerPort {
  return env.CONTROLLER.get(env.CONTROLLER.idFromName('controller')) as unknown as ControllerPort
}

function dependencies(env: Env) {
  return {
    controller: controller(env),
    webhooks: env.WEBHOOKS,
    state: env.STATE,
    allowedOwners: parseAllowedOwners(env.ALLOWED_OWNERS),
    // Half a configuration throws, so a mistake fails closed instead of leaving the dashboard open.
    access: accessSettings(env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD),
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    now: Date.now,
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, dependencies(env))
  },

  async queue(batch, env): Promise<void> {
    await handleQueue(batch, dependencies(env))
  },

  /** A deploy or a host move can stop the Container. The cron brings it back within minutes. */
  async scheduled(_controller, env): Promise<void> {
    await controller(env).ensureRunning()
  },
} satisfies ExportedHandler<Env, WebhookDelivery>
