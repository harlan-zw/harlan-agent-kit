import type { H3, H3Event } from 'h3'
import type { SessionController } from './session-controller.ts'
import { createError } from 'h3'
import { parseDesktopEvents } from './desktop-protocol.ts'
import { parseSessionFence, parseSessionMessage, parseSessionProjects, parseStartSession, sessionRecord, sessionText } from './session-protocol.ts'

export function registerSessionRoutes(app: H3, controller: SessionController): void {
  function route(method: 'get' | 'post', path: string, handler: (event: H3Event) => unknown): void {
    app[method](path, (event) => {
      if (event.req.headers.get('x-harlan-agent-ingress') === 'public')
        throw createError({ status: 403, message: 'Connect through Tailscale to use Agent sessions.' })
      return handler(event)
    })
  }
  async function body(request: Request): Promise<Record<string, unknown>> {
    const text = await request.text()
    if (text.length > 2_000_000)
      throw createError({ status: 413, message: 'Agent session data is too large.' })
    return sessionRecord(JSON.parse(text))
  }
  async function boundary<T>(operation: () => T | Promise<T>): Promise<T> {
    return await Promise.resolve().then(operation).catch((error: unknown) => {
      throw createError({ status: 400, message: error instanceof Error ? error.message : 'Agent session data is invalid.' })
    })
  }
  route('get', '/api/sessions', () => controller.snapshot())
  route('get', '/api/sessions/:id', event => boundary(() => controller.get(sessionText(event.context.params?.id, 'Session ID'))))
  route('post', '/api/sessions', event => boundary(async () => controller.start(parseStartSession(await body(event.req)))))
  route('post', '/api/sessions/:id/messages', event => boundary(async () => controller.message(sessionText(event.context.params?.id, 'Session ID'), parseSessionMessage(await body(event.req)))))
  route('post', '/api/sessions/:id/stop', event => boundary(() => controller.stop(sessionText(event.context.params?.id, 'Session ID'))))
  route('post', '/api/desktop/sessions/report', event => boundary(async () => {
    const input = await body(event.req)
    if (!Number.isSafeInteger(input.protocol))
      throw new Error('Set a valid desktop Session protocol.')
    return controller.report({ instanceId: sessionText(input.instanceId, 'desktop instance'), protocol: Number(input.protocol), projects: parseSessionProjects(input.projects) })
  }))
  route('post', '/api/desktop/sessions/claim', event => boundary(async () => {
    const input = await body(event.req)
    if (!Number.isSafeInteger(input.freeSlots) || Number(input.freeSlots) < 0 || Number(input.freeSlots) > 2)
      throw new Error('Set valid free Agent slots.')
    return controller.claim({ instanceId: sessionText(input.instanceId, 'desktop instance'), freeSlots: Number(input.freeSlots) })
  }))
  route('post', '/api/desktop/sessions/heartbeat', event => boundary(async () => controller.heartbeat(parseSessionFence(await body(event.req)))))
  route('post', '/api/desktop/sessions/defer', event => boundary(async () => controller.defer(parseSessionFence(await body(event.req)))))
  route('post', '/api/desktop/sessions/events', event => boundary(async () => {
    const input = await body(event.req)
    if (!Number.isSafeInteger(input.seq) || Number(input.seq) < 1)
      throw new Error('Set a valid Agent event sequence.')
    return controller.events({ ...parseSessionFence(input), seq: Number(input.seq), events: parseDesktopEvents(input.events) })
  }))
  route('post', '/api/desktop/sessions/complete', event => boundary(async () => {
    const input = await body(event.req)
    const outcome = input.outcome
    if (outcome !== 'completed' && outcome !== 'stopped' && outcome !== 'failed')
      throw new Error('Set a valid Agent turn outcome.')
    const workspacePath = input.workspacePath === undefined ? undefined : sessionText(input.workspacePath, 'Worktree path', 4096)
    if (workspacePath !== undefined && !workspacePath.startsWith('/'))
      throw new Error('Set an absolute Worktree path.')
    return controller.complete({ ...parseSessionFence(input), outcome, ...(workspacePath === undefined ? {} : { workspacePath }), ...(input.providerSessionId === undefined ? {} : { providerSessionId: sessionText(input.providerSessionId, 'provider Session ID') }), ...(input.reason === undefined ? {} : { reason: sessionText(input.reason, 'failure reason', 20_000) }) })
  }))
}
