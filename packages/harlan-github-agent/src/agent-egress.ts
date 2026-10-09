import type { LookupAddress } from 'node:dns'
import type { IncomingHttpHeaders, Server } from 'node:http'
import type { Socket } from 'node:net'
import { lookup } from 'node:dns/promises'
import { createServer, request } from 'node:http'
import { connect, isIP } from 'node:net'

export function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4)
    return false
  const [a, b, c] = address.split('.').map(Number)
  return a !== undefined && b !== undefined && c !== undefined
    && a !== 0 && a !== 10 && a !== 127 && a < 224
    && !(a === 100 && b >= 64 && b <= 127)
    && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31)
    && !(a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
    && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    && !(a === 203 && b === 0 && c === 113)
}

export interface AgentEgress {
  close: () => Promise<void>
  socketPath: string
}

/** Resolve once, reject every private answer, then connect to the approved numeric address. */
export async function agentEgressAddress(hostname: string, resolve: (hostname: string) => Promise<LookupAddress[]> = hostname => lookup(hostname, { all: true, family: 4 })): Promise<string> {
  const addresses = isIP(hostname) === 0 ? await resolve(hostname) : [{ address: hostname, family: isIP(hostname) }]
  if (addresses.length === 0 || addresses.some(entry => !publicIPv4(entry.address)))
    throw new Error('The Agent egress destination must have only public IPv4 addresses.')
  return addresses[0]!.address
}

function destination(value: string, connectRequest: boolean): URL {
  const url = new URL(connectRequest ? `http://${value}` : value)
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || ![80, 443].includes(port))
    throw new Error('The Agent egress destination must use public HTTP or HTTPS.')
  return url
}

export async function createAgentEgress(socketPath: string): Promise<AgentEgress> {
  const sockets = new Set<Socket>()
  const server: Server = createServer((incoming, outgoing) => {
    void (async () => {
      const target = destination(incoming.url ?? '', false)
      if (target.protocol !== 'http:')
        throw new Error('Use CONNECT for HTTPS egress.')
      const address = await agentEgressAddress(target.hostname)
      const headers: IncomingHttpHeaders = { ...incoming.headers, host: target.host }
      delete headers['proxy-authorization']
      delete headers['proxy-connection']
      const forwarded = request({ host: address, port: Number(target.port || 80), path: `${target.pathname}${target.search}`, method: incoming.method, headers }, (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(outgoing)
      })
      forwarded.once('error', () => {
        if (!outgoing.headersSent)
          outgoing.writeHead(502)
        outgoing.end('Agent egress failed.\n')
      })
      outgoing.once('close', () => forwarded.destroy())
      incoming.pipe(forwarded)
    })().catch(() => {
      outgoing.writeHead(403)
      outgoing.end('Agent egress refused the destination.\n')
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    // A client can leave before parsing or DNS finishes. Own errors for the whole connection lifetime.
    socket.on('error', () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('connect', (incoming, client, head) => {
    void (async () => {
      const target = destination(incoming.url ?? '', true)
      const address = await agentEgressAddress(target.hostname)
      const upstream = connect({ host: address, port: Number(target.port || 80) })
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0)
          upstream.write(head)
        client.pipe(upstream)
        upstream.pipe(client)
      })
      upstream.once('error', () => client.destroy())
      client.once('close', () => upstream.destroy())
    })().catch(() => client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return {
    socketPath,
    close: () => new Promise((resolve, reject) => {
      for (const socket of sockets)
        socket.destroy()
      server.close(error => error ? reject(error) : resolve())
    }),
  }
}
