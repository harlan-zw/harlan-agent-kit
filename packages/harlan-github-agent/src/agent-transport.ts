import type { AddressInfo, Socket } from 'node:net'
import { connect, createServer } from 'node:net'

/** Only this turn's OpenCode Unix socket is reachable through this host listener. */
export async function createAgentTransport(socketPath: string): Promise<{ url: string, close: () => Promise<void> }> {
  const sockets = new Set<Socket>()
  const server = createServer((incoming) => {
    const outgoing = connect({ path: socketPath })
    sockets.add(incoming)
    sockets.add(outgoing)
    incoming.pipe(outgoing)
    outgoing.pipe(incoming)
    incoming.once('error', () => outgoing.destroy())
    outgoing.once('error', () => incoming.destroy())
    incoming.once('close', () => {
      outgoing.destroy()
      sockets.delete(incoming)
    })
    outgoing.once('close', () => {
      incoming.destroy()
      sockets.delete(outgoing)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve, reject) => {
      for (const socket of sockets)
        socket.destroy()
      server.close(error => error ? reject(error) : resolve())
    }),
  }
}
