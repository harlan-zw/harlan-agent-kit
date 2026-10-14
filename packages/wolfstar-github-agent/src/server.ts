import type { H3 } from 'h3'
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Server } from 'srvx'
import { serve } from 'srvx'

export interface AgentServerOptions {
  app: H3
  hostname: string
  port: number
  terminals?: {
    handles: (path: string) => boolean
    handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>
    upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>
  }
}

export async function startAgentServer(options: AgentServerOptions): Promise<Server> {
  const server = serve({
    fetch: (request) => options.app.fetch(request),
    hostname: options.hostname,
    port: options.port,
    manual: true,
  })
  if (options.terminals) {
    const node = server.node
    if (!node?.server) throw new Error('Agent terminals require the Node server adapter.')
    const http = node.server as HttpServer
    const terminals = options.terminals
    const path = (request: IncomingMessage): string | undefined => {
      const target = request.url ?? '/'
      return URL.canParse(target, 'http://localhost') ? new URL(target, 'http://localhost').pathname : undefined
    }
    http.removeListener('request', node.handler)
    http.on('request', (request, response) => {
      const pathname = path(request)
      if (pathname === undefined) {
        response.writeHead(400).end()
        return
      }
      if (!terminals.handles(pathname)) {
        void node.handler(request, response)
        return
      }
      void terminals.handle(request, response).catch((cause: unknown) => {
        console.error('Terminal request failed.', cause instanceof Error ? cause.message : String(cause))
        if (!response.headersSent) response.writeHead(503).end()
        else response.destroy()
      })
    })
    http.on('upgrade', (request, socket, head) => {
      const pathname = path(request)
      if (pathname === undefined) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        return
      }
      if (!terminals.handles(pathname)) {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
        return
      }
      void terminals.upgrade(request, socket, head).catch((cause: unknown) => {
        console.error('Terminal attachment failed.', cause instanceof Error ? cause.message : String(cause))
        socket.destroy()
      })
    })
  }
  await server.serve()
  await server.ready()
  return server
}
