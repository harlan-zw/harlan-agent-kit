import type { ControllerPort } from './env.ts'

/**
 * The origin the controller's dashboard accepts. It checks Host and Origin
 * against `server.allowed_origin`, which the Container sets to this value.
 * Keep in step with `CONTAINER_DASHBOARD_ORIGIN` in the agent package.
 */
export const CONTROLLER_ORIGIN = 'https://wolfstar-github-agent.localhost'

/**
 * Proxies one dashboard request to the controller, with the rules the Caddy route held.
 *
 * The controller still checks its password on every route. This proxy only
 * translates the public origin, which is whatever hostname the Worker serves,
 * to the controller's own. A state changing request must carry the exact
 * public Origin, and only that exact value is translated, so a missing or
 * foreign Origin never reaches the controller looking trusted.
 */
export async function proxyDashboard(request: Request, controller: ControllerPort): Promise<Response> {
  const url = new URL(request.url)
  const origin = request.headers.get('origin')
  if (request.method !== 'GET' && request.method !== 'HEAD' && origin !== url.origin)
    return new Response('Request origin is not allowed.', { status: 403 })

  // The URL host becomes the Host header the controller checks.
  const target = new URL(url.pathname + url.search, CONTROLLER_ORIGIN.replace('https:', 'http:'))
  const headers = new Headers(request.headers)
  if (origin === url.origin) headers.set('origin', CONTROLLER_ORIGIN)

  return controller.proxyDashboard(
    new Request(target, {
      method: request.method,
      headers,
      // Dashboard writes are small JSON bodies. Buffering them keeps the request replayable over RPC.
      body: request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer(),
      redirect: 'manual',
    }),
  )
}
