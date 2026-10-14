import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createAgentApp } from '../src/app.ts'
import { createBrowserAuthorities } from '../src/browser-auth-authorities.ts'
import { openBrowserAuthStore } from '../src/browser-auth-store.ts'
import { dashboardSnapshot } from './fixtures.ts'

it('disables only configured public password access and preserves its final Passkey', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'passkey-only-authority-'))
  const publicOrigin = 'https://agent.example.com'
  const path = join(directory, createHash('sha256').update(publicOrigin).digest('hex'))
  mkdirSync(path, { mode: 0o700 })
  const store = openBrowserAuthStore(join(path, 'auth.sqlite'))
  store.addCredential({
    id: 'fixture-key',
    label: 'Passkey',
    created: 1,
    credential: { id: 'fixture-key', publicKey: new Uint8Array([1]), counter: 0 },
  })
  store.close()
  const authorities = createBrowserAuthorities({
    directory,
    origin: 'https://private.example.com',
    publicOrigin,
    publicPasswordLogin: false,
    privateTerminalHost: false,
    password: 'fixture',
    now: Date.now,
  })
  try {
    const publicAuth = authorities.public!
    const session = await publicAuth.handle(
      new Request(`${publicOrigin}/api/browser-auth/session`, { headers: { host: 'agent.example.com' } }),
    )
    expect(await session?.json()).toMatchObject({ bootstrapKind: 'passkey', passkeys: true })
    const bootstrap = (authority: typeof publicAuth) =>
      authority.handle(
        new Request(`${authority.origin}/api/browser-auth/bootstrap`, {
          method: 'POST',
          headers: { host: new URL(authority.origin).host, origin: authority.origin },
          body: JSON.stringify({ password: 'fixture' }),
        }),
      )
    expect((await bootstrap(publicAuth))?.status).toBe(401)
    expect((await bootstrap(authorities.private))?.status).toBe(200)
    const cookie = publicAuth.issueSession('fixture-key').split(';')[0]!
    const app = createAgentApp({
      allowedOrigin: authorities.private.origin,
      dashboardPassword: 'fixture',
      browserAuth: authorities,
      now: () => new Date(),
      store: { getDashboardSnapshot: () => dashboardSnapshot() } as never,
    })
    const authorization = `Basic ${Buffer.from('agent:fixture').toString('base64')}`
    for (const path of ['/api/state', '/api/events']) {
      const request = new Request(`${authorities.private.origin}${path}`, {
        headers: { host: 'private.example.com', authorization, 'x-wolfstar-agent-ingress': 'public' },
      })
      expect((await app.fetch(request)).status).toBe(401)
    }
    expect(
      (
        await app.fetch(
          new Request(`${authorities.private.origin}/api/state`, {
            headers: { host: 'private.example.com', authorization },
          }),
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await app.fetch(
          new Request(`${authorities.private.origin}/api/state`, {
            headers: { host: 'private.example.com', cookie, 'x-wolfstar-agent-ingress': 'public' },
          }),
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await publicAuth.handle(
          new Request(`${publicOrigin}/api/browser-auth/credentials/remove`, {
            method: 'POST',
            headers: { host: 'agent.example.com', origin: publicOrigin, cookie },
            body: JSON.stringify({ id: 'fixture-key' }),
          }),
        )
      )?.status,
    ).toBe(409)
    expect(publicAuth.session(new Headers({ cookie }))).not.toBeNull()
  } finally {
    authorities.close()
    rmSync(directory, { recursive: true })
  }
})

it('refuses public password disable without an enrolled public Passkey', () => {
  const directory = mkdtempSync(join(tmpdir(), 'passkey-only-empty-'))
  expect(() =>
    createBrowserAuthorities({
      directory,
      origin: 'https://private.example.com',
      publicOrigin: 'https://agent.example.com',
      publicPasswordLogin: false,
      privateTerminalHost: false,
      password: 'fixture',
      now: Date.now,
    }),
  ).toThrow('Public Passkey login requires an enrolled Passkey')
  rmSync(directory, { recursive: true })
})

it('identifies both configured private and public browser authorities as a Dashboard', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dashboard-authority-'))
  const authorities = createBrowserAuthorities({
    directory,
    origin: 'https://private.example.com',
    publicOrigin: 'https://agent.example.com',
    privateTerminalHost: false,
    password: 'fixture',
    now: Date.now,
  })
  try {
    for (const authority of [authorities.private, authorities.public!]) {
      const response = await authority.handle(
        new Request(`${authority.origin}/api/browser-auth/session`, {
          headers: { host: new URL(authority.origin).host },
        }),
      )
      expect(await response?.json()).toMatchObject({ surface: { _tag: 'Dashboard' }, authenticated: false })
    }
  } finally {
    authorities.close()
    rmSync(directory, { recursive: true })
  }
})
it('retains configured private terminals while refusing their discovery on public ingress', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dashboard-authority-'))
  const authorities = createBrowserAuthorities({
    directory,
    origin: 'https://private.example.com',
    publicOrigin: 'https://agent.example.com',
    privateTerminalHost: true,
    password: 'fixture',
    now: Date.now,
  })
  try {
    const session = async (authority: typeof authorities.private) =>
      (await authority.handle(
        new Request(`${authority.origin}/api/browser-auth/session`, {
          headers: { host: new URL(authority.origin).host },
        }),
      ))!.json()
    expect(await session(authorities.private)).toMatchObject({ surface: { _tag: 'TerminalHost' } })
    expect(await session(authorities.public!)).toMatchObject({ surface: { _tag: 'Dashboard' } })
  } finally {
    authorities.close()
    rmSync(directory, { recursive: true })
  }
})
