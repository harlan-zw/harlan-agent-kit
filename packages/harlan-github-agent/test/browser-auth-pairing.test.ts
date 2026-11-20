import type { BrowserWebAuthn } from '../src/browser-auth.ts'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { createAgentApp } from '../src/app.ts'
import { browserAuthStorePath, createBrowserAuthorities, createPairingLink, pairingTarget } from '../src/browser-auth-authorities.ts'
import { openBrowserAuthStore } from '../src/browser-auth-store.ts'
import { createTerminalServer } from '../src/terminal.ts'
import { dashboardSnapshot } from './fixtures.ts'

vi.mock('../src/terminal-helper-client.ts', () => ({ connectTerminalHelper: () => ({ close() {}, send: () => true }) }))

const privateOrigin = 'https://private.example.com'
const publicOrigin = 'https://agent.example.com'
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'browser-auth-pairing-'))
  directories.push(directory)
  return join(directory, 'browser-auth')
}
function stubWebAuthn() {
  return {
    generateRegistrationOptions: vi.fn(async () => ({ challenge: 'registration-challenge' })),
    generateAuthenticationOptions: vi.fn(async () => ({ challenge: 'authentication-challenge' })),
    verifyRegistrationResponse: vi.fn(async () => ({ verified: true, registrationInfo: { credential: { id: 'new-key', publicKey: new Uint8Array([1]), counter: 0 } } })),
    verifyAuthenticationResponse: vi.fn(async () => ({ verified: true, authenticationInfo: { newCounter: 1 } })),
  }
}
function seedPasskey(directory: string, origin: string, ids: string[]) {
  const path = browserAuthStorePath(directory, origin)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const store = openBrowserAuthStore(path)
  for (const id of ids)
    store.addCredential({ id, label: id, created: 1, credential: { id, publicKey: new Uint8Array([1]), counter: 0 } })
  store.close()
}
function cookies(response: Response | null) {
  return response!.headers.getSetCookie().map(value => value.split(';')[0]!).filter(value => !value.endsWith('='))
}
function post(origin: string, action: string, body: unknown, cookie = '') {
  return new Request(`${origin}/api/browser-auth/${action}`, { method: 'POST', headers: { host: new URL(origin).host, origin, cookie }, body: JSON.stringify(body) })
}
function get(origin: string, action: string, cookie = '') {
  return new Request(`${origin}/api/browser-auth/${action}`, { headers: { host: new URL(origin).host, cookie } })
}
function token(url: string) {
  return new URLSearchParams(new URL(url).hash.slice(1)).get('pair')!
}

it('redeems a pairing link once, only at its own origin, and only within five minutes', async () => {
  const directory = temporary()
  let now = 1_000_000
  const authorities = createBrowserAuthorities({ directory, origin: privateOrigin, publicOrigin, privateTerminalHost: false, now: () => now })
  try {
    const link = createPairingLink({ directory, origin: privateOrigin, now: () => now })
    expect(link._tag).toBe('Ok')
    if (link._tag !== 'Ok')
      return
    expect(link.value.url.startsWith(`${privateOrigin}/#pair=`)).toBe(true)
    expect((await authorities.public!.handle(post(publicOrigin, 'bootstrap', { token: token(link.value.url) })))?.status).toBe(401)
    const first = await authorities.private.handle(post(privateOrigin, 'bootstrap', { token: token(link.value.url) }))
    expect(first?.status).toBe(200)
    expect(cookies(first)).toHaveLength(1)
    expect((await authorities.private.handle(post(privateOrigin, 'bootstrap', { token: token(link.value.url) })))?.status).toBe(401)

    const late = createPairingLink({ directory, origin: privateOrigin, now: () => now })
    if (late._tag !== 'Ok')
      throw new Error('Expected a pairing link')
    now += 5 * 60 * 1000
    expect((await authorities.private.handle(post(privateOrigin, 'bootstrap', { token: token(late.value.url) })))?.status).toBe(401)
  }
  finally {
    authorities.close()
  }
})

it('starts with zero Passkeys and refuses the dashboard password as a browser sign-in', async () => {
  const directory = temporary()
  const authorities = createBrowserAuthorities({ directory, origin: privateOrigin, publicOrigin, privateTerminalHost: false, now: Date.now })
  try {
    for (const authority of [authorities.private, authorities.public!]) {
      expect(authority.hasPasskeys()).toBe(false)
      expect(await (await authority.handle(get(authority.origin, 'session')))!.json()).toMatchObject({ authenticated: false, enrolment: false, bootstrapKind: 'passkey', passkeys: false })
      expect((await authority.handle(post(authority.origin, 'bootstrap', { password: 'fixture' })))?.status).toBe(401)
    }
  }
  finally {
    authorities.close()
  }
})

it('refuses every Control API route to an enrol-only session', async () => {
  const directory = temporary()
  const authorities = createBrowserAuthorities({ directory, origin: privateOrigin, privateTerminalHost: false, now: Date.now })
  try {
    const link = createPairingLink({ directory, origin: privateOrigin, now: Date.now })
    if (link._tag !== 'Ok')
      throw new Error('Expected a pairing link')
    const [enrolment] = cookies(await authorities.private.handle(post(privateOrigin, 'bootstrap', { token: token(link.value.url) })))
    expect(await (await authorities.private.handle(get(privateOrigin, 'session', enrolment)))!.json()).toMatchObject({ authenticated: false, enrolment: true })
    expect((await authorities.private.handle(get(privateOrigin, 'credentials', enrolment)))?.status).toBe(403)
    expect((await authorities.private.handle(post(privateOrigin, 'credentials/remove', { id: 'any' }, enrolment)))?.status).toBe(403)

    const app = createAgentApp({ allowedOrigin: privateOrigin, dashboardPassword: 'fixture', browserAuth: authorities, now: () => new Date(), store: { getDashboardSnapshot: () => dashboardSnapshot() } as never })
    const routes = app['~routes'].filter(route => route.route?.startsWith('/api/') && !route.route.startsWith('/api/browser-auth/'))
    expect(routes.length).toBeGreaterThan(20)
    for (const route of routes) {
      const path = route.route!.replace(/:\w+/g, 'fixture').replace(/\*\*?/g, 'fixture')
      const method = route.method ?? 'GET'
      const request = (cookie: string) => new Request(`${privateOrigin}${path}`, { method, headers: { host: 'private.example.com', origin: privateOrigin, cookie }, ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }) })
      expect([`${method} ${route.route}`, (await app.fetch(request(enrolment!))).status]).toEqual([`${method} ${route.route}`, 403])
      expect([`${method} ${route.route}`, (await app.fetch(request(''))).status]).toEqual([`${method} ${route.route}`, 401])
    }
  }
  finally {
    authorities.close()
  }
})

it('enrols the public origin through the public ingress with only its own pairing links', async () => {
  const directory = temporary()
  const authorities = createBrowserAuthorities({ directory, origin: privateOrigin, publicOrigin, privateTerminalHost: false, now: Date.now })
  try {
    const app = createAgentApp({ allowedOrigin: privateOrigin, dashboardPassword: 'fixture', browserAuth: authorities, now: () => new Date(), store: { getDashboardSnapshot: () => dashboardSnapshot() } as never })
    const publicIngress = { 'host': 'private.example.com', 'origin': privateOrigin, 'x-harlan-agent-ingress': 'public' }
    const mint = (origin: string) => {
      const link = createPairingLink({ directory, origin, now: Date.now })
      if (link._tag !== 'Ok')
        throw new Error('Expected a pairing link')
      return token(link.value.url)
    }
    const bootstrap = (secret: string) => app.fetch(new Request(`${privateOrigin}/api/browser-auth/bootstrap`, { method: 'POST', headers: publicIngress, body: JSON.stringify({ token: secret }) }))
    expect((await bootstrap(mint(privateOrigin))).status).toBe(401)
    const response = await bootstrap(mint(publicOrigin))
    expect(response.status).toBe(200)
    const [enrolment] = cookies(response)
    expect((await app.fetch(new Request(`${privateOrigin}/api/state`, { headers: { ...publicIngress, cookie: enrolment! } }))).status).toBe(403)
    expect((await app.fetch(new Request(`${privateOrigin}/api/state`, { headers: { host: 'private.example.com', cookie: enrolment! } }))).status).toBe(401)
  }
  finally {
    authorities.close()
  }
})

it('lets an enrol-only session add one discoverable, verified Passkey, then signs in with it', async () => {
  const directory = temporary()
  const webauthn = stubWebAuthn()
  const authorities = createBrowserAuthorities({ directory, origin: privateOrigin, privateTerminalHost: false, now: Date.now, webauthn: webauthn as unknown as BrowserWebAuthn })
  const auth = authorities.private
  try {
    const link = createPairingLink({ directory, origin: privateOrigin, now: Date.now })
    if (link._tag !== 'Ok')
      throw new Error('Expected a pairing link')
    const [enrolment] = cookies(await auth.handle(post(privateOrigin, 'bootstrap', { token: token(link.value.url) })))
    const options = await auth.handle(post(privateOrigin, 'registration/options', {}, enrolment))
    expect(options?.status).toBe(200)
    expect(webauthn.generateRegistrationOptions).toHaveBeenCalledWith(expect.objectContaining({ authenticatorSelection: { residentKey: 'required', userVerification: 'required' } }))
    const [challenge] = cookies(options)
    const registered = await auth.handle(post(privateOrigin, 'registration/verify', { response: { id: 'new-key' }, label: 'Laptop' }, `${enrolment}; ${challenge}`))
    expect(registered?.status).toBe(200)
    expect(webauthn.verifyRegistrationResponse).toHaveBeenCalledWith(expect.objectContaining({ requireUserVerification: true }))
    const [session] = cookies(registered)
    expect(auth.session(new Headers({ cookie: session! }))?.credentialId).toBe('new-key')
    expect(auth.enrolment(new Headers({ cookie: enrolment! }))).toBeNull()
    expect((await auth.handle(post(privateOrigin, 'registration/options', {}, enrolment)))?.status).toBe(401)
  }
  finally {
    authorities.close()
  }
})

it('never removes the last Passkey of a Service origin', async () => {
  const directory = temporary()
  seedPasskey(directory, privateOrigin, ['only-key'])
  seedPasskey(directory, publicOrigin, ['first-key', 'second-key'])
  const authorities = createBrowserAuthorities({ directory, origin: privateOrigin, publicOrigin, privateTerminalHost: false, now: Date.now })
  try {
    const privateCookie = authorities.private.issueSession('only-key').split(';')[0]!
    expect((await authorities.private.handle(post(privateOrigin, 'credentials/remove', { id: 'only-key' }, privateCookie)))?.status).toBe(409)
    expect(authorities.private.session(new Headers({ cookie: privateCookie }))).not.toBeNull()
    const publicCookie = authorities.public!.issueSession('first-key').split(';')[0]!
    expect((await authorities.public!.handle(post(publicOrigin, 'credentials/remove', { id: 'second-key' }, publicCookie)))?.status).toBe(200)
    expect((await authorities.public!.handle(post(publicOrigin, 'credentials/remove', { id: 'first-key' }, publicCookie)))?.status).toBe(409)
  }
  finally {
    authorities.close()
  }
})

it('grants nothing to a session from the retired password sign-in', async () => {
  const directory = temporary()
  seedPasskey(directory, privateOrigin, ['key'])
  const authorities = createBrowserAuthorities({ directory, origin: privateOrigin, privateTerminalHost: false, now: Date.now })
  try {
    const legacy = authorities.private.issueSession(null).split(';')[0]!
    expect(authorities.private.session(new Headers({ cookie: legacy }))).toBeNull()
    expect((await authorities.private.handle(post(privateOrigin, 'registration/options', {}, legacy)))?.status).toBe(401)
    const app = createAgentApp({ allowedOrigin: privateOrigin, dashboardPassword: 'fixture', browserAuth: authorities, now: () => new Date(), store: { getDashboardSnapshot: () => dashboardSnapshot() } as never })
    expect((await app.fetch(new Request(`${privateOrigin}/api/state`, { headers: { host: 'private.example.com', cookie: legacy } }))).status).toBe(401)
    const authorization = `Basic ${Buffer.from('agent:fixture').toString('base64')}`
    expect((await app.fetch(new Request(`${privateOrigin}/api/state`, { headers: { host: 'private.example.com', authorization } }))).status).toBe(200)
  }
  finally {
    authorities.close()
  }
})

it('keeps Passkeys from a store created before pairing links and signs in with them', async () => {
  const directory = temporary()
  const path = browserAuthStorePath(directory, privateOrigin)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const previous = openBrowserAuthStore(path)
  previous.close()
  const database = new DatabaseSync(path)
  database.exec('DROP TABLE IF EXISTS pairings; DROP TABLE IF EXISTS enrolments;')
  database.close()
  seedPasskey(directory, privateOrigin, ['existing-key'])
  const webauthn = stubWebAuthn()
  const authorities = createBrowserAuthorities({ directory, origin: privateOrigin, privateTerminalHost: false, now: Date.now, webauthn: webauthn as unknown as BrowserWebAuthn })
  try {
    const store = openBrowserAuthStore(path)
    const userHandle = store.userId.toString('base64url')
    store.close()
    const options = await authorities.private.handle(post(privateOrigin, 'authentication/options', {}))
    const [challenge] = cookies(options)
    const signedIn = await authorities.private.handle(post(privateOrigin, 'authentication/verify', { response: { id: 'existing-key', response: { userHandle } } }, challenge))
    expect(signedIn?.status).toBe(200)
    const [session] = cookies(signedIn)
    expect(authorities.private.session(new Headers({ cookie: session! }))?.credentialId).toBe('existing-key')
    expect(createPairingLink({ directory, origin: privateOrigin, now: Date.now })._tag).toBe('Ok')
  }
  finally {
    authorities.close()
  }
})

it('refuses Service terminals to an enrol-only session', async () => {
  const directory = temporary()
  const authorities = createBrowserAuthorities({ directory, origin: privateOrigin, privateTerminalHost: true, now: Date.now })
  const api = createTerminalServer({ manager: { capabilities: () => ({ hostLabel: 'Hogwild' }), intent: () => undefined } as never, origin: privateOrigin, authorize: () => false, browserAuth: authorities.private, now: Date.now, log: () => {} })
  try {
    const link = createPairingLink({ directory, origin: privateOrigin, now: Date.now })
    if (link._tag !== 'Ok')
      throw new Error('Expected a pairing link')
    const [enrolment] = cookies(await authorities.private.handle(post(privateOrigin, 'bootstrap', { token: token(link.value.url) })))
    await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
    const address = api.server.address()
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP listener')
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${address.port}/api/terminal/capabilities`, { headers: { host: 'private.example.com', cookie: enrolment!, connection: 'close' } }, (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      request.once('error', reject)
      request.end()
    })
    expect(status).toBe(401)
    const upgrade = await new Promise<string>((resolve, reject) => {
      const socket = connect(address.port, '127.0.0.1')
      socket.once('error', reject)
      socket.once('data', (data) => {
        resolve(data.toString())
        socket.destroy()
      })
      socket.once('connect', () => socket.write(`GET /api/terminal/sessions/${'a'.repeat(24)}/stream HTTP/1.1\r\nHost: private.example.com\r\nOrigin: ${privateOrigin}\r\nCookie: ${enrolment}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`))
    })
    expect(upgrade).toContain('403 Forbidden')
  }
  finally {
    await api.close()
    authorities.close()
  }
})

it('names only configured, persistent browser origins as pairing targets', () => {
  const config = { storage: { path: '/home/agent/.local/share/harlan-github-agent/state.sqlite' }, server: { allowedOrigin: privateOrigin, browserOrigins: [publicOrigin] } }
  expect(pairingTarget(config, `${publicOrigin}/`)).toEqual({ _tag: 'Ok', value: { directory: '/home/agent/.local/share/harlan-github-agent/browser-auth', origin: publicOrigin } })
  const unknown = pairingTarget(config, 'https://other.example.com')
  expect(unknown._tag === 'Err' && unknown.error).toContain(privateOrigin)
  expect(pairingTarget(config, undefined)._tag).toBe('Err')
  expect(pairingTarget({ ...config, storage: { path: ':memory:' } }, privateOrigin)._tag).toBe('Err')
})
