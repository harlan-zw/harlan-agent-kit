import { connect } from 'node:net'
import { H3 } from 'h3'
import { expect, it } from 'vitest'
import { startAgentServer } from '../src/server.ts'

it('serves Controller and terminal requests through one listener', async () => {
  const app = new H3()
  app.get('/api/state', () => ({ controller: true }))
  const handled: string[] = []
  const server = await startAgentServer({
    app,
    hostname: '127.0.0.1',
    port: 0,
    terminals: {
      handles: (path) => path.startsWith('/api/terminal/'),
      handle: async (request, response) => {
        handled.push(request.url!)
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ terminal: true }))
      },
      upgrade: async (_request, socket) => {
        socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      },
    },
  })
  const address = server.node!.server!.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.')
  const origin = `http://127.0.0.1:${address.port}`
  try {
    expect(await (await fetch(`${origin}/api/state`)).json()).toEqual({ controller: true })
    expect(await (await fetch(`${origin}/api/terminal/sessions`)).json()).toEqual({ terminal: true })
    expect((await fetch(`${origin}/missing`)).status).toBe(404)
    expect(handled).toEqual(['/api/terminal/sessions'])
    const upgrade = (path: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = connect(address.port, '127.0.0.1', () => {
          socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)
        })
        socket.setTimeout(1000, () => socket.destroy(new Error('Upgrade timed out.')))
        socket.once('error', reject)
        socket.once('data', (data) => {
          socket.destroy()
          resolve(data.toString())
        })
      })
    expect(await upgrade('/api/terminal/sessions/id/stream')).toContain('101 Switching Protocols')
    expect(await upgrade('/api/state')).toContain('404 Not Found')
    expect(await upgrade('http://[')).toContain('400 Bad Request')
  } finally {
    await server.close()
  }
})

it('returns a refused terminal request without breaking Controller requests', async () => {
  const app = new H3()
  app.get('/api/state', () => ({ controller: true }))
  const server = await startAgentServer({
    app,
    hostname: '127.0.0.1',
    port: 0,
    terminals: {
      handles: (path) => path.startsWith('/api/terminal/'),
      handle: async () => {
        throw new Error('Terminal transport failed.')
      },
      upgrade: async () => {
        throw new Error('Terminal attachment failed.')
      },
    },
  })
  const address = server.node!.server!.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.')
  try {
    const origin = `http://127.0.0.1:${address.port}`
    expect((await fetch(`${origin}/api/terminal/sessions`)).status).toBe(503)
    expect(await (await fetch(`${origin}/api/state`)).json()).toEqual({ controller: true })
  } finally {
    await server.close()
  }
})
