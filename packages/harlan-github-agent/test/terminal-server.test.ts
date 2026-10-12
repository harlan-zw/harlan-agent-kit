import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createTerminalManager, createTerminalServer } from '../src/terminal.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
it('pairs once, rejects unauthenticated and wrong-origin access, and preserves pairing across API restart', async () => {
  const root = join(homedir(), 'scratch')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'terminal-server-test-'))
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
  const options = { manager, origin, now: Date.now, log: () => {} }
  let api = createTerminalServer(options)
  await new Promise<void>(resolve =>
    api.server.listen(43627, '127.0.0.1', resolve),
  )
  cleanup.push(async () => {
    await api.close()
    manager.close()
    await rm(directory, { recursive: true })
  })
  expect((await fetch(`${origin}/api/terminal/capabilities`)).status).toBe(401)
  expect(
    (
      await fetch(`${origin}/api/terminal/pair`, {
        method: 'POST',
        headers: { origin: 'https://wrong.example' },
        body: JSON.stringify({ code: api.pairCode }),
      })
    ).status,
  ).toBe(403)
  const paired = await fetch(`${origin}/api/terminal/pair`, {
    method: 'POST',
    headers: { origin },
    body: JSON.stringify({ code: api.pairCode }),
  })
  expect(await paired.json()).toEqual({ _tag: 'Ok', value: true })
  const cookie = paired.headers.get('set-cookie')!.split(';')[0]!
  expect(
    (
      await fetch(`${origin}/api/terminal/pair`, {
        method: 'POST',
        headers: { origin },
        body: JSON.stringify({ code: api.pairCode }),
      })
    ).status,
  ).toBe(401)
  expect(
    await (
      await fetch(`${origin}/api/terminal/capabilities`, {
        headers: { cookie },
      })
    ).json(),
  ).toMatchObject({ controller: false, hostLabel: 'Fixture' })
  await api.close()
  api = createTerminalServer(options)
  await new Promise<void>(resolve =>
    api.server.listen(43627, '127.0.0.1', resolve),
  )
  expect(
    (
      await fetch(`${origin}/api/terminal/capabilities`, {
        headers: { cookie, connection: 'close' },
      })
    ).status,
  ).toBe(200)
})
