import type { H3 } from 'h3'
import type { Server } from 'srvx'
import { serve } from 'srvx'

export interface AgentServerOptions {
  app: H3
  hostname: string
  port: number
}

export async function startAgentServer(options: AgentServerOptions): Promise<Server> {
  const server = serve({
    fetch: request => options.app.fetch(request),
    hostname: options.hostname,
    port: options.port,
  })
  await server.ready()
  return server
}
