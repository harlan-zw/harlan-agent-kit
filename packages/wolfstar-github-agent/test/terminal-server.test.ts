import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'
import { createTerminalManager, createTerminalServer } from '../src/terminal.ts'

const cleanup: (() => Promise<void>)[] = []
// Each restart probe opens a fresh client connection. Existing transports may close during an API restart.
function request(url: string, options?: Parameters<typeof fetch>[1]) {
  const headers = new Headers(options?.headers)
  headers.set('connection', 'close')
  return fetch(url, { ...options, headers })
}
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
it('pairs once, rejects unauthenticated and wrong-origin access, and preserves pairing across API restart', async () => {
  const root = join(homedir(), 'scratch')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'terminal-server-test-'))
  await writeFile(
    join(directory, 'index.html'),
    '<!doctype html><title>Terminal proof</title><script>window.bootstrap=true</script>',
  )
  const manager = await createTerminalManager({
    directory,
    bootId: 'boot',
    hostLabel: 'Fixture',
    controller: false,
    projects: [],
    providers: {
      codex: { executable: '/missing', argv: [], available: false },
      claude: { executable: '/missing', argv: [], available: false },
      opencode: { executable: '/missing', argv: [], available: false },
    },
    artifact: {
      entry: '/artifact',
      digest: 'digest',
      wasm: '/wasm',
      wasmDigest: 'wasm',
    },
    admissionCli: '/capacity',
    claimScript: '/claim',
    memoryGiB: 1,
    admission: {
      completedReceipt: async () => ({ _tag: 'Missing' }),
      status: async () => ({ _tag: 'Unavailable', reason: 'Fixture' }),
      reserve: async () => ({ _tag: 'Unavailable', reason: 'Fixture' }),
      bind: async () => ({ _tag: 'Missing' }),
      reconcile: async () => ({ _tag: 'Empty' }),
      release: async () => ({ _tag: 'Empty' }),
      cancel: async () => ({ _tag: 'Empty' }),
    },
    processHost: {
      inspect: async () => {
        throw new Error('Unexpected process inspection')
      },
      start: async () => {
        throw new Error('Unexpected provider launch')
      },
      stop: async () => 'Unknown',
    },
    recoverWorktree: async () => null,
    releaseWorktree: async () => {},
    renewWorktree: async () => {},
    ready: async () => false,
    now: () => new Date(),
    log: () => {},
  })
  const origin = 'http://127.0.0.1:43627'
  const options = {
    manager,
    origin,
    staticDirectory: directory,
    now: Date.now,
    log: () => {},
  }
  let api = createTerminalServer(options)
  await new Promise<void>((resolve) => api.server.listen(43627, '127.0.0.1', resolve))
  cleanup.push(async () => {
    await api.close()
    manager.close()
    await rm(directory, { recursive: true })
  })
  const home = await request(origin)
  expect(home.headers.get('content-type')).toBe('text/html; charset=utf-8')
  const html = await home.text()
  expect(html).toContain('<title>Terminal proof</title>')
  const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1]
  expect(nonce).toBeTruthy()
  expect(home.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`)
  expect((await request(`${origin}/api/terminal/capabilities`)).status).toBe(401)
  expect(
    (
      await request(`${origin}/api/terminal/pair`, {
        method: 'POST',
        headers: { origin: 'https://wrong.example' },
        body: JSON.stringify({ code: api.pairCode }),
      })
    ).status,
  ).toBe(403)
  const paired = await request(`${origin}/api/terminal/pair`, {
    method: 'POST',
    headers: { origin },
    body: JSON.stringify({ code: api.pairCode }),
  })
  expect(await paired.json()).toEqual({ _tag: 'Ok', value: true })
  const cookie = paired.headers.get('set-cookie')!.split(';')[0]!
  expect(
    (
      await request(`${origin}/api/terminal/pair`, {
        method: 'POST',
        headers: { origin },
        body: JSON.stringify({ code: api.pairCode }),
      })
    ).status,
  ).toBe(401)
  expect(
    await (
      await request(`${origin}/api/terminal/capabilities`, {
        headers: { cookie },
      })
    ).json(),
  ).toMatchObject({ controller: false, hostLabel: 'Fixture' })
  await api.close()
  api = createTerminalServer(options)
  await new Promise<void>((resolve) => api.server.listen(43627, '127.0.0.1', resolve))
  expect(
    (
      await request(`${origin}/api/terminal/capabilities`, {
        headers: { cookie, connection: 'close' },
      })
    ).status,
  ).toBe(200)
  const stranded = connect({
    host: '127.0.0.1',
    port: 43627,
    allowHalfOpen: true,
  })
  cleanup.unshift(async () => {
    stranded.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    stranded.once('error', reject)
    stranded.once('data', () => resolve())
    stranded.once('connect', () =>
      stranded.write(
        `GET /unknown-upgrade HTTP/1.1\r\nHost: 127.0.0.1:43627\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      ),
    )
  })
  expect(await Promise.race([api.close().then(() => true), delay(500).then(() => false)])).toBe(true)
})
