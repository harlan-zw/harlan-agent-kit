import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createAgentApp } from '../src/app.ts'
import { createBrowserAuthorities } from '../src/browser-auth-authorities.ts'
import { openBrowserAuthStore } from '../src/browser-auth-store.ts'

it('requires a public Passkey session and same-origin POST, bounds input, and binds options to the signed-in credential', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'emergency-routes-'))
  const publicOrigin = 'https://agent.example.com'
  const privateOrigin = 'https://private.example.com'
  const path = join(directory, createHash('sha256').update(publicOrigin).digest('hex'))
  mkdirSync(path, { mode: 0o700 })
  const store = openBrowserAuthStore(join(path, 'auth.sqlite'))
  store.addCredential({ id: 'fixture-key', label: 'Passkey', created: 1, credential: { id: 'fixture-key', publicKey: new Uint8Array([1]), counter: 0 } })
  store.close()
  const browserAuth = createBrowserAuthorities({ directory, origin: privateOrigin, publicOrigin, publicPasswordLogin: false, privateTerminalHost: false, password: 'fixture', now: Date.now })
  const proxy = vi.fn(async () => Response.json({ available: true, locked: false }))
  const app = createAgentApp({ allowedOrigin: privateOrigin, dashboardPassword: 'fixture', browserAuth, emergencyIsolation: proxy, now: () => new Date(), store: {} as never })
  const publicCookie = browserAuth.public!.issueSession('fixture-key').split(';')[0]!
  const passwordCookie = browserAuth.public!.issueSession(null).split(';')[0]!
  const privateCookie = browserAuth.private.issueSession('fixture-key').split(';')[0]!
  const headers = { 'host': 'private.example.com', 'origin': privateOrigin, 'cookie': publicCookie, 'x-harlan-agent-ingress': 'public' }
  const request = (operation: string, overrides: Record<string, string> = {}, body = '{}', method = 'POST') => app.request(`${privateOrigin}/api/emergency-isolation/${operation}`, { method, headers: { ...headers, ...overrides }, ...(method === 'POST' ? { body } : {}) })
  try {
    expect((await request('options', { cookie: '' })).status).toBe(401)
    expect((await request('options', { cookie: '', authorization: `Basic ${Buffer.from('agent:fixture').toString('base64')}` })).status).toBe(401)
    expect((await request('options', { cookie: passwordCookie })).status).toBe(403)
    expect((await request('options', { 'cookie': privateCookie, 'x-harlan-agent-ingress': '' })).status).toBe(403)
    expect((await request('options', { origin: 'https://evil.example' })).status).toBe(403)
    expect((await request('options', {}, 'x'.repeat(65537))).status).toBe(413)
    expect((await request('options', {}, '{broken')).status).toBe(400)
    expect(proxy).not.toHaveBeenCalled()
    expect((await request('options', {}, '{"credentialId":"attacker-selected"}')).status).toBe(200)
    expect(proxy).toHaveBeenLastCalledWith('options', { credentialId: 'fixture-key' })
    expect((await request('poweroff-options', { cookie: passwordCookie })).status).toBe(403)
    expect((await request('poweroff', { origin: 'https://evil.example' })).status).toBe(403)
    expect((await request('poweroff-options', {}, '{"credentialId":"attacker-selected"}')).status).toBe(200)
    expect(proxy).toHaveBeenLastCalledWith('poweroff-options', { credentialId: 'fixture-key' })
    const poweroff = { ceremonyId: 'poweroff-proof', response: { id: 'fixture-key' }, confirmation: 'POWER-OFF-HOGWILD' }
    await request('poweroff', {}, JSON.stringify(poweroff))
    expect(proxy).toHaveBeenLastCalledWith('poweroff', poweroff)
    expect((await request('poweroff', {}, '', 'GET')).status).toBe(404)
    const forwarded = { ceremonyId: 'one-shot', response: { id: 'fixture-key' }, confirmation: 'ISOLATE-HOGWILD' }
    await request('isolate', {}, JSON.stringify(forwarded))
    expect(proxy).toHaveBeenLastCalledWith('isolate', forwarded)
    expect((await request('status', {}, '', 'GET')).status).toBe(200)
    proxy.mockRejectedValueOnce(new Error('socket unavailable'))
    expect((await request('status', {}, '', 'GET')).status).toBe(503)
    expect((await request('isolate', {}, '', 'GET')).status).toBe(404)
    await browserAuth.public!.handle(new Request(`${publicOrigin}/api/browser-auth/logout`, { method: 'POST', headers: { host: 'agent.example.com', origin: publicOrigin, cookie: publicCookie }, body: '{}' }))
    expect((await request('isolate', {}, JSON.stringify(forwarded))).status).toBe(401)
  }
  finally {
    browserAuth.close()
    rmSync(directory, { recursive: true })
  }
})
