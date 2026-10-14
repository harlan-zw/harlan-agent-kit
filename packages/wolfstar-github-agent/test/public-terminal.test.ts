import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createBrowserAuthorities } from '../src/browser-auth-authorities.ts'
import { openBrowserAuthStore } from '../src/browser-auth-store.ts'
import { createTerminalServer } from '../src/terminal.ts'

vi.mock('../src/terminal-helper-client.ts', () => ({ connectTerminalHelper: () => ({ close() {}, send: () => true }) }))

it('authenticates public terminal HTTP and upgrades only with the public browser session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'public-terminal-'))
  const origin = 'https://private.example.com'
  const publicOrigin = 'https://agent.example.com'
  const path = join(directory, createHash('sha256').update(publicOrigin).digest('hex'))
  await mkdir(path, { mode: 0o700 })
  const store = openBrowserAuthStore(join(path, 'auth.sqlite'))
  store.addCredential({
    id: 'key',
    label: 'Passkey',
    created: 1,
    credential: { id: 'key', publicKey: new Uint8Array([1]), counter: 0 },
  })
  store.close()
  const auth = createBrowserAuthorities({
    directory,
    origin,
    publicOrigin,
    publicPasswordLogin: false,
    publicTerminalHost: true,
    privateTerminalHost: true,
    password: 'fixture',
    now: Date.now,
  })
  let running = false
  const api = createTerminalServer({
    manager: {
      capabilities: () => ({ hostLabel: 'Hogwild' }),
      intent: () => (running ? { session: { state: 'Running' } } : undefined),
    } as never,
    origin,
    authorize: () => true,
    browserAuth: auth.private,
    publicBrowserAuth: auth.public!,
    now: Date.now,
    log: () => {},
  })
  await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve))
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
  const url = `http://127.0.0.1:${address.port}`
  const cookie = auth.public!.issueSession('key').split(';')[0]!
  const privateCookie = auth.private.issueSession(null).split(';')[0]!
  const passwordCookie = auth.public!.issueSession(null).split(';')[0]!
  const headers = { host: 'private.example.com', 'x-wolfstar-agent-ingress': 'public', connection: 'close' }
  const fetch = (url: string, options: { method?: string; headers: Record<string, string>; body?: string }) =>
    new Promise<Response>((resolve, reject) => {
      const request = httpRequest(url, { method: options.method, headers: options.headers }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500 })))
      })
      request.once('error', reject)
      request.end(options.body)
    })
  const upgrade = (cookie: string, requestOrigin = origin) =>
    new Promise<string>((resolve, reject) => {
      const socket = connect(address.port, '127.0.0.1')
      socket.once('error', reject)
      socket.once('data', (data) => {
        resolve(data.toString())
        socket.destroy()
      })
      socket.once('connect', () =>
        socket.write(
          `GET /api/terminal/sessions/${'a'.repeat(24)}/stream HTTP/1.1\r\nHost: private.example.com\r\nOrigin: ${requestOrigin}\r\nX-Wolfstar-Agent-Ingress: public\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
        ),
      )
    })
  try {
    const session = await auth.public!.handle(
      new Request(`${publicOrigin}/api/browser-auth/session`, { headers: { host: 'agent.example.com' } }),
    )
    expect(await session!.json()).toMatchObject({ surface: { _tag: 'TerminalHost' } })
    expect((await fetch(`${url}/api/terminal/capabilities`, { headers: { ...headers, cookie } })).status).toBe(200)
    for (const credential of ['', privateCookie, passwordCookie])
      expect(
        (await fetch(`${url}/api/terminal/capabilities`, { headers: { ...headers, cookie: credential } })).status,
      ).toBe(401)
    const passwordSession = await auth.public!.handle(
      new Request(`${publicOrigin}/api/browser-auth/session`, {
        headers: { host: 'agent.example.com', cookie: passwordCookie },
      }),
    )
    expect(await passwordSession!.json()).toMatchObject({ authenticated: false })
    expect(
      (
        await fetch(`${url}/api/terminal/capabilities`, {
          headers: { ...headers, cookie, origin: 'https://evil.example.com' },
        })
      ).status,
    ).toBe(403)
    expect(
      (await fetch(`${url}/api/terminal/sessions`, { method: 'POST', headers: { ...headers, cookie }, body: '{}' }))
        .status,
    ).toBe(403)
    expect(await upgrade(cookie)).toContain('409 Conflict')
    expect(await upgrade(privateCookie)).toContain('403 Forbidden')
    expect(await upgrade(passwordCookie)).toContain('403 Forbidden')
    expect(await upgrade(cookie, 'https://evil.example.com')).toContain('403 Forbidden')
    running = true
    const websocket = new WebSocket(`ws://127.0.0.1:${address.port}/api/terminal/sessions/${'a'.repeat(24)}/stream`, {
      headers: { ...headers, origin, cookie },
    })
    await new Promise<void>((resolve, reject) => {
      websocket.once('open', resolve)
      websocket.once('error', reject)
    })
    const revoked = new Promise<number>((resolve) => websocket.once('close', (code) => resolve(code)))
    await auth.public!.handle(
      new Request(`${publicOrigin}/api/browser-auth/logout`, {
        method: 'POST',
        headers: { host: 'agent.example.com', origin: publicOrigin, cookie },
        body: '{}',
      }),
    )
    expect(await revoked).toBe(1008)
    expect((await fetch(`${url}/api/terminal/capabilities`, { headers: { ...headers, cookie } })).status).toBe(401)
    expect(await upgrade(cookie)).toContain('403 Forbidden')
  } finally {
    await api.close()
    auth.close()
    await rm(directory, { recursive: true })
  }
})
