import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openBrowserAuthStore } from '../src/browser-auth-store.ts'
import { createBrowserAuth } from '../src/browser-auth.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
it('consumes a challenge once and binds it to its browser, ceremony and session', () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-auth-'))
  directories.push(directory)
  const store = openBrowserAuthStore(join(directory, 'auth.sqlite'))
  store.challenge({
    hash: 'browser',
    challenge: 'nonce',
    ceremony: 'registration',
    sessionHash: 'session',
    origin: 'http://localhost:43177',
    rpId: 'localhost',
    expires: 200,
  })
  expect(store.consume('browser', 'registration', 'different', 100)).toBeNull()
  expect(store.consume('browser', 'authentication', null, 100)).toBeNull()
  expect(store.consume('browser', 'registration', 'session', 100)?.challenge).toBe('nonce')
  expect(store.consume('browser', 'registration', 'session', 100)).toBeNull()
  store.close()
})
it('persists sessions across restart and expires or revokes them', () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-auth-'))
  directories.push(directory)
  const path = join(directory, 'auth.sqlite')
  const first = openBrowserAuthStore(path)
  first.session({ hash: 'opaque-hash', credentialId: null, expires: 200 })
  first.close()
  const second = openBrowserAuthStore(path)
  expect(second.sessionByHash('opaque-hash', 100)).not.toBeNull()
  expect(second.sessionByHash('opaque-hash', 200)).toBeNull()
  second.revokeSession('opaque-hash')
  expect(second.sessionByHash('opaque-hash', 100)).toBeNull()
  second.close()
})

it('refuses wrong origins, malformed bodies and oversized unauthenticated ceremonies', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-auth-'))
  directories.push(directory)
  const store = openBrowserAuthStore(join(directory, 'auth.sqlite'))
  const auth = createBrowserAuth({
    origin: 'http://localhost:43177',
    rpId: 'localhost',
    store,
    now: () => 1000,
    surface: { _tag: 'TerminalHost' },
    bootstrapKind: 'password',
    bootstrap: (body) => body.password === 'fixture',
  })
  const request = (body: string, origin = auth.origin) =>
    new Request(`${auth.origin}/api/browser-auth/bootstrap`, {
      method: 'POST',
      headers: { host: 'localhost:43177', origin },
      body,
    })
  expect((await auth.handle(request('{"password":"fixture"}', 'https://foreign.example')))?.status).toBe(403)
  expect((await auth.handle(request('{broken')))?.status).toBe(400)
  expect((await auth.handle(request('x'.repeat(65537))))?.status).toBe(413)
  expect((await auth.handle(request('{"password":"wrong"}')))?.status).toBe(401)
  const response = await auth.handle(request('{"password":"fixture"}'))
  expect(response?.status).toBe(200)
  const cookie = response!.headers.getSetCookie()[0]!.split(';')[0]!
  expect(auth.session(new Headers({ cookie }))).not.toBeNull()
  expect(
    (
      await auth.handle(
        new Request(`${auth.origin}/api/browser-auth/logout`, {
          method: 'POST',
          headers: { host: 'localhost:43177', origin: auth.origin, cookie },
          body: '{}',
        }),
      )
    )?.status,
  ).toBe(200)
  expect(auth.session(new Headers({ cookie }))).toBeNull()
  store.close()
})
