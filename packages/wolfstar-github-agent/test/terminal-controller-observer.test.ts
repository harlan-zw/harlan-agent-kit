import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import {
  createTerminalControllerObserver,
  parseTerminalControllerObserverConfig,
} from '../src/terminal-controller-observer.ts'

const servers: Server[] = []
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test address')
  return `http://127.0.0.1:${address.port}`
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }),
  )
})
const config = { origin: 'https://controller.example', passwordFile: '/home/agent/password' }
it('parses only exact HTTPS origins and absolute secret files', () => {
  expect(parseTerminalControllerObserverConfig({ ...config, extra: 'ignored' })).toEqual({ _tag: 'Ok', value: config })
  for (const origin of [
    'http://controller.example',
    'https://user:secret@controller.example',
    'https://controller.example/',
    'https://controller.example/api',
    'https://controller.example?q=1',
    'https://controller.example#x',
  ])
    expect(parseTerminalControllerObserverConfig({ ...config, origin })).toEqual({
      _tag: 'Err',
      error: 'InvalidRequest',
    })
  expect(parseTerminalControllerObserverConfig({ ...config, passwordFile: 'password' })).toEqual({
    _tag: 'Err',
    error: 'InvalidRequest',
  })
})
async function fixture(remote: (request: IncomingMessage, response: ServerResponse) => void) {
  const upstream = await listen(remote)
  const urls: string[] = []
  const logs: unknown[] = []
  const observer = createTerminalControllerObserver({
    ...config,
    password: 'remote-secret',
    log: (...args) => logs.push(args),
    fetch: async (url, options) => {
      urls.push(String(url))
      return fetch(String(url).replace(config.origin, upstream), options)
    },
  })
  const local = await listen((request, response) => {
    void observer.handle(request, response)
  })
  return { local, urls, logs, observer }
}
it('injects only remote credentials and preserves bounded JSON without remote headers', async () => {
  const requests: IncomingMessage[] = []
  const f = await fixture((request, response) => {
    requests.push(request)
    response
      .writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'secret=remote',
        'X-Remote-Secret': 'remote-secret',
      })
      .end('{"agents":[]}')
  })
  const response = await fetch(`${f.local}/api/maintenance/state?limit=1`, {
    headers: {
      Authorization: 'Basic browser-secret',
      Cookie: 'browser=secret',
      Origin: 'https://browser.example',
      'X-Private': 'secret',
    },
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ agents: [] })
  expect(requests[0]!.headers.authorization).toBe(`Basic ${Buffer.from('agent:remote-secret').toString('base64')}`)
  expect(requests[0]!.headers.origin).toBe(config.origin)
  expect(requests[0]!.headers.cookie).toBeUndefined()
  expect(requests[0]!.headers['x-private']).toBeUndefined()
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('x-remote-secret')).toBeNull()
  expect(f.urls).toEqual(['https://controller.example/api/state?limit=1'])
  expect(f.observer.handles('/api/maintenance/unknown')).toBe(true)
  expect(f.observer.handles('/api/terminal/sessions')).toBe(false)
})
it('refuses mutations and unknown or encoded routes without upstream calls', async () => {
  const f = await fixture((_, response) => response.end())
  for (const path of ['/state', '/agents/pause', '/unknown', '/%2F%2Fevil.example/state', '/state/extra']) {
    const response = await fetch(`${f.local}/api/maintenance${path}`, { method: path === '/state' ? 'POST' : 'GET' })
    expect(response.status).toBe(405)
    expect(await response.json()).toEqual({ _tag: 'Err', error: 'InvalidRequest' })
  }
  expect(f.urls).toEqual([])
})
it('refuses absolute and network request targets without contacting another origin', async () => {
  const f = await fixture((_, response) => response.end())
  for (const path of ['https://evil.example/api/maintenance/state', '//evil.example/api/maintenance/state']) {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(f.local, { path }, (response) => {
        response.resume()
        resolve(response.statusCode!)
      })
      request.once('error', reject)
      request.end()
    })
    expect(status).toBe(405)
  }
  expect(f.urls).toEqual([])
})
it.each([302, 401, 500])('hides remote secret errors and refuses redirects: %s', async (status) => {
  const f = await fixture((_, response) =>
    response
      .writeHead(status, { 'Content-Type': 'application/json', Location: 'http://127.0.0.1/secrets' })
      .end('{"secret":"remote-secret"}'),
  )
  const response = await fetch(`${f.local}/api/maintenance/state`)
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ _tag: 'Err', error: 'Unavailable' })
  expect(f.urls).toHaveLength(1)
  expect(JSON.stringify(f.logs)).not.toContain('remote-secret')
})
it('maps connection outages to a generic Unavailable response', async () => {
  const observer = createTerminalControllerObserver({
    ...config,
    password: 'remote-secret',
    log: () => {},
    fetch: async () => {
      throw new Error('remote-secret')
    },
  })
  const local = await listen((request, response) => {
    void observer.handle(request, response)
  })
  const response = await fetch(`${local}/api/maintenance/state`)
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ _tag: 'Err', error: 'Unavailable' })
})
it('refuses oversized JSON before exposing any body bytes', async () => {
  const f = await fixture((_, response) =>
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify('x'.repeat(8 * 1024 * 1024))),
  )
  const response = await fetch(`${f.local}/api/maintenance/state`)
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ _tag: 'Err', error: 'Unavailable' })
})
it('streams SSE and cancels upstream when the browser disconnects', async () => {
  let closed!: () => void
  const upstreamClosed = new Promise<void>((resolve) => {
    closed = resolve
  })
  const f = await fixture((_, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Set-Cookie': 'secret=remote' })
    response.write('event: state\ndata: {"agents":[]}\n\n')
    response.once('close', closed)
  })
  const controller = new AbortController()
  const response = await fetch(`${f.local}/api/maintenance/events`, { signal: controller.signal })
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const reader = response.body!.getReader()
  const chunk = await reader.read()
  expect(new TextDecoder().decode(chunk.value)).toContain('event: state')
  controller.abort()
  await upstreamClosed
})
it('closes oversized SSE events across multiple chunks', async () => {
  const f = await fixture((_, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write('event: state\ndata: ')
    for (let index = 0; index < 9; index++) response.write('x'.repeat(1024 * 1024))
    response.end('\n\n')
  })
  const response = await fetch(`${f.local}/api/maintenance/events`)
  const read = async () => {
    const reader = response.body!.getReader()
    let bytes = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return bytes
      bytes += chunk.value.byteLength
    }
  }
  await expect(read()).rejects.toThrow()
})
it('applies backpressure when a browser stops consuming SSE', async () => {
  let writes = 0
  const chunk = Buffer.from(`data: ${'x'.repeat(512 * 1024)}\n\n`)
  const f = await fixture((_, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    async function send() {
      while (!response.destroyed && writes < 256) {
        writes++
        if (!response.write(chunk)) {
          await new Promise<void>((resolve) => {
            const ready = () => {
              response.removeListener('close', ready)
              response.removeListener('drain', ready)
              resolve()
            }
            response.once('drain', ready)
            response.once('close', ready)
          })
        }
      }
      response.end()
    }
    void send()
  })
  const controller = new AbortController()
  await fetch(`${f.local}/api/maintenance/events`, { signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(writes).toBeGreaterThan(0)
  expect(writes).toBeLessThan(256)
  controller.abort()
})
it('supports HEAD without forwarding a body', async () => {
  const methods: string[] = []
  const f = await fixture((request, response) => {
    methods.push(request.method!)
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"secret":"remote-secret"}')
  })
  const response = await fetch(`${f.local}/api/maintenance/state`, { method: 'HEAD' })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('')
  expect(methods).toEqual(['HEAD'])
})
