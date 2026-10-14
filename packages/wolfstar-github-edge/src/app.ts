import type { ControllerPort, WebhookDelivery } from './env.ts'
import { proxyDashboard } from './dashboard.ts'
import { handleSetup, isReady } from './setup.ts'
import { acceptWebhook, consumeWebhooks } from './webhook.ts'

/** Everything the routes need, so tests run them without Cloudflare bindings. */
export interface EdgeDependencies {
  controller: ControllerPort
  webhooks: Queue<WebhookDelivery>
  state: R2Bucket
  allowedOwners: string[]
  fetch: typeof fetch
  now: () => number
}

export function parseAllowedOwners(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((owner) => owner.trim())
    .filter((owner) => owner !== '')
}

export async function handleRequest(request: Request, dependencies: EdgeDependencies): Promise<Response> {
  const url = new URL(request.url)
  if (url.protocol === 'http:') {
    url.protocol = 'https:'
    return Response.redirect(url.toString(), 308)
  }

  // Only this exact path reaches the webhook relay. `/webhook/` stays a dashboard route.
  if (url.pathname === '/webhook') {
    if (request.method !== 'POST') return new Response('Method not allowed.', { status: 405 })
    return acceptWebhook(request, {
      controller: dependencies.controller,
      webhooks: dependencies.webhooks,
      bodies: dependencies.state,
    })
  }

  const setup = await handleSetup(request, {
    store: {
      read: dependencies.controller.readSetup,
      write: dependencies.controller.writeSetup,
      restart: dependencies.controller.restart,
    },
    allowedOwners: dependencies.allowedOwners,
    fetch: dependencies.fetch,
    now: dependencies.now,
  })
  if (setup !== null) return setup

  // Until setup is complete there is no controller to show.
  if (!isReady(await dependencies.controller.readSetup())) return Response.redirect(`${url.origin}/setup`, 303)
  return proxyDashboard(request, dependencies.controller)
}

export async function handleQueue(batch: MessageBatch<WebhookDelivery>, dependencies: EdgeDependencies): Promise<void> {
  await consumeWebhooks(batch, {
    controller: dependencies.controller,
    webhooks: dependencies.webhooks,
    bodies: dependencies.state,
  })
}
