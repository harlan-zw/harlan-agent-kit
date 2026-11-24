import type { H3 } from 'h3'
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Server } from 'srvx'
import { serve } from 'srvx'
import { compressResponse } from './response-compression.ts'

export interface AgentServerOptions {
  app: H3
  hostname: string
  port: number
  terminals?: {
    handles: (path: string) => boolean
    handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>
    upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>
  }
  /** How long a request in flight at close may run before close cuts it. Defaults to 2 seconds. */
  closeGraceMilliseconds?: number
}

export interface AgentServer {
  readonly url: string | undefined
  readonly node: Server['node']
  /** Stops listening, lets requests in flight finish, and cuts every connection when the grace ends. */
  close: () => Promise<void>
}

const IDLE_SWEEP_MILLISECONDS = 50

/**
 * Node drops idle keep-alive sockets once, when close() starts. A socket that
 * is busy then stays open, and Node serves every later request on it. One
 * request in flight holds close() for the 5 second keep-alive timeout. A
 * client that reuses the socket within that timeout holds it with no limit.
 * Drop each socket once it goes idle, and cut the rest when the grace ends.
 */
function closeWithin(server: Server, graceMilliseconds: number): Promise<void> {
  const http = server.node?.server as HttpServer | undefined
  if (http === undefined)
    return server.close()
  const sweep = setInterval(() => http.closeIdleConnections(), IDLE_SWEEP_MILLISECONDS)
  const deadline = setTimeout(() => http.closeAllConnections(), graceMilliseconds)
  return server.close().finally(() => {
    clearInterval(sweep)
    clearTimeout(deadline)
  })
}

export async function startAgentServer(options: AgentServerOptions): Promise<AgentServer> {
  const server = serve({
    fetch: async request => compressResponse(request, await options.app.fetch(request)),
    hostname: options.hostname,
    port: options.port,
    manual: true,
  })
  if (options.terminals) {
    const node = server.node
    if (!node?.server)
      throw new Error('Agent terminals require the Node server adapter.')
    const http = node.server as HttpServer
    const terminals = options.terminals
    const path = (request: IncomingMessage): string | undefined => {
      const target = request.url ?? '/'
      return URL.canParse(target, 'http://localhost')
        ? new URL(target, 'http://localhost').pathname
        : undefined
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
        if (!response.headersSent)
          response.writeHead(503).end()
        else
          response.destroy()
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
  const closeGraceMilliseconds = options.closeGraceMilliseconds ?? 2_000
  return {
    get url() { return server.url },
    node: server.node,
    close: () => closeWithin(server, closeGraceMilliseconds),
  }
}
