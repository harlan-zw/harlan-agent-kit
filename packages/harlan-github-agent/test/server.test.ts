import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { gunzipSync } from 'node:zlib'
import { createEventStream, H3 } from 'h3'
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
      handles: path => path.startsWith('/api/terminal/'),
      handle: async (request, response) => {
        handled.push(request.url!)
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ terminal: true }))
      },
      upgrade: async (_request, socket) => { socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n') },
    },
  })
  const address = server.node!.server!.address()
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP listener.')
  const origin = `http://127.0.0.1:${address.port}`
  try {
    expect(await (await fetch(`${origin}/api/state`)).json()).toEqual({ controller: true })
    expect(await (await fetch(`${origin}/api/terminal/sessions`)).json()).toEqual({ terminal: true })
    expect((await fetch(`${origin}/missing`)).status).toBe(404)
    expect(handled).toEqual(['/api/terminal/sessions'])
    const upgrade = (path: string) => new Promise<string>((resolve, reject) => {
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
  }
  finally {
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
      handles: path => path.startsWith('/api/terminal/'),
      handle: async () => { throw new Error('Terminal transport failed.') },
      upgrade: async () => { throw new Error('Terminal attachment failed.') },
    },
  })
  const address = server.node!.server!.address()
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP listener.')
  try {
    const origin = `http://127.0.0.1:${address.port}`
    expect((await fetch(`${origin}/api/terminal/sessions`)).status).toBe(503)
    expect(await (await fetch(`${origin}/api/state`)).json()).toEqual({ controller: true })
  }
  finally {
    await server.close()
  }
})

function rawResponse(url: string, acceptEncoding: string): Promise<{ headers: import('node:http').IncomingHttpHeaders, body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { 'accept-encoding': acceptEncoding } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
}

it('reduces dashboard bytes on the wire while preserving snapshots and encoding opt-outs', async () => {
  const state = { agents: Array.from({ length: 500 }, (_, id) => ({ id, activity: 'Reviewing the session state and recovering a failed connection. '.repeat(80) })) }
  const app = new H3()
  app.get('/api/state', () => state)
  const server = await startAgentServer({ app, hostname: '127.0.0.1', port: 0 })
  const address = server.node!.server!.address()
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP listener.')
  const url = `http://127.0.0.1:${address.port}/api/state`
  try {
    const compressed = await rawResponse(url, 'gzip, deflate, br')
    expect(compressed.headers['content-encoding']).toBe('gzip')
    expect(compressed.headers.vary).toContain('Accept-Encoding')
    expect(JSON.parse(gunzipSync(compressed.body).toString())).toEqual(state)
    expect(compressed.body.length).toBeLessThan(JSON.stringify(state).length / 4)
    for (const accept of ['identity', 'gzip;q=0, *;q=1']) {
      const identity = await rawResponse(url, accept)
      expect(identity.headers['content-encoding']).toBeUndefined()
      expect(JSON.parse(identity.body.toString())).toEqual(state)
    }
  }
  finally {
    await server.close()
  }
})

it('delivers compressed live updates before close and releases a cancelled subscriber', async () => {
  const app = new H3()
  let send: ((value: string) => Promise<void>) | undefined
  let closed = false
  app.get('/api/events', (event) => {
    const stream = createEventStream(event)
    send = async (value) => {
      await stream.push({ event: 'heartbeat', data: value })
    }
    stream.onClosed(() => {
      closed = true
    })
    void stream.push({ event: 'state', data: JSON.stringify({ message: 'session output '.repeat(1000) }) })
    return stream
  })
  const server = await startAgentServer({ app, hostname: '127.0.0.1', port: 0 })
  const address = server.node!.server!.address()
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP listener.')
  const controller = new AbortController()
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, { headers: { 'accept-encoding': 'gzip' }, signal: controller.signal })
    expect(response.headers.get('content-encoding')).toBe('gzip')
    const reader = response.body!.getReader()
    const decode = new TextDecoder()
    let received = ''
    const until = async (text: string): Promise<void> => {
      while (!received.includes(text)) {
        const chunk = await reader.read()
        if (chunk.done)
          throw new Error('Stream ended before the update.')
        received += decode.decode(chunk.value)
      }
    }
    await until('event: state')
    await send!('still connected')
    await until('data: still connected')
    expect(closed).toBe(false)
    controller.abort()
    await expect.poll(() => closed).toBe(true)
  }
  finally {
    controller.abort()
    await server.close()
  }
})

it('closes a keep-alive socket that a proxy keeps reusing after close starts', { timeout: 5_000 }, async () => {
  const app = new H3()
  app.get('/api/state', async () => {
    await new Promise(resolve => setTimeout(resolve, 100))
    return { controller: true }
  })
  const server = await startAgentServer({ app, hostname: '127.0.0.1', port: 0 })
  const address = server.node!.server!.address()
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP listener.')
  // A pooling proxy sends every request over one upstream socket. The dashboard
  // reconnects its event stream every 1.5 s, which is under the 5 s keep-alive timeout.
  const socket = connect(address.port, '127.0.0.1')
  const send = () => socket.writable && socket.write('GET /api/state HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n')
  let answered = 0
  socket.on('data', (chunk) => {
    answered += chunk.toString().split('HTTP/1.1 200 ').length - 1
    setTimeout(send, 300)
  })
  const socketClosed = new Promise(resolve => socket.once('close', resolve))
  try {
    await new Promise(resolve => socket.once('connect', resolve))
    send()
    // The first request is still in flight when the close starts.
    await new Promise(resolve => setTimeout(resolve, 20))
    const started = performance.now()

    await server.close()

    expect(performance.now() - started).toBeLessThan(1_000)
    await socketClosed
    expect(answered).toBe(1)
  }
  finally {
    socket.destroy()
  }
})

it('cuts a request that never answers when the close grace ends', { timeout: 5_000 }, async () => {
  const app = new H3()
  let arrived = false
  app.get('/api/hang', () => {
    arrived = true
    return new Promise(() => undefined)
  })
  const server = await startAgentServer({ app, hostname: '127.0.0.1', port: 0, closeGraceMilliseconds: 200 })
  const address = server.node!.server!.address()
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP listener.')
  const response = fetch(`http://127.0.0.1:${address.port}/api/hang`).then(() => 'answered', () => 'cut')
  await expect.poll(() => arrived).toBe(true)
  const started = performance.now()

  await server.close()

  expect(performance.now() - started).toBeGreaterThanOrEqual(190)
  expect(performance.now() - started).toBeLessThan(1_000)
  expect(await response).toBe('cut')
})
