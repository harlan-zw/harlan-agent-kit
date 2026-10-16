import type { Socket } from 'node:net'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import WebSocket from 'ws'
import { openBrowserAuthStore } from '../src/browser-auth-store.ts'
import { createBrowserAuth } from '../src/browser-auth.ts'
import { createTerminalServer } from '../src/terminal-server.ts'

async function fixture(machine = false, race = false, state = 'Running') {
  const directory = mkdtempSync(join(tmpdir(), 'passkey-stream-'))
  const id = 'a'.repeat(24)
  mkdirSync(join(directory, 'sessions', id), { recursive: true })
  const store = openBrowserAuthStore(join(directory, 'auth.sqlite'))
  let now = 1000
  const origin = 'http://localhost:43829'
  const auth = createBrowserAuth({ origin, rpId: 'localhost', store, now: () => now, surface: { _tag: 'TerminalHost' }, bootstrapKind: 'pairing', bootstrap: () => false })
  store.addCredential({ id: 'credential', label: 'Fixture', created: now, credential: { id: 'credential', publicKey: new Uint8Array([1]), counter: 0 } })
  const cookie = auth.issueSession('credential').split(';')[0]!
  const forwarded: string[] = []
  let peer: Socket | undefined
  const helper = createServer((socket) => {
    peer = socket
    socket.on('error', (cause: NodeJS.ErrnoException) => {
      // Revocation closes the helper before this fixture's attempted output.
      if (cause.code !== 'EPIPE')
        throw cause
    })
    socket.on('data', bytes => forwarded.push(bytes.toString()))
  })
  helper.listen(join(directory, 'sessions', id, 'owner.sock'))
  await once(helper, 'listening')
  const action = async (name: string, body: unknown = {}) => auth.handle(new Request(`${origin}/api/browser-auth/${name}`, { method: 'POST', headers: { host: 'localhost:43829', origin, cookie }, body: JSON.stringify(body) }))
  const api = createTerminalServer({
    manager: { directory, intent: () => ({ session: { id, state }, helperToken: 'fixture' }) } as never,
    origin,
    browserAuth: auth,
    now: () => now,
    log: () => {},
    ...(machine || race
      ? { authorize: async () => {
          if (race)
            await action('logout')
          return machine
        } }
      : {}),
  })
  api.server.listen(43829, '127.0.0.1')
  await once(api.server, 'listening')
  const socket = new WebSocket(`ws://localhost:43829/api/terminal/sessions/${id}/stream`, { headers: { origin, cookie } })
  return {
    socket,
    forwarded,
    action,
    advance: () => { now += 31 * 86400000 },
    output: () => peer?.write(`${JSON.stringify({ type: 'Screen', text: 'private-screen' })}\n`),
    async close() {
      socket.terminate()
      await api.close()
      await new Promise<void>(resolve => helper.close(() => resolve()))
      store.close()
      rmSync(directory, { recursive: true })
    },
  }
}

it('restores a saved history page after its helper has stopped', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ended-history-stream-'))
  const id = 'b'.repeat(24)
  const generation = 'generation'
  mkdirSync(join(directory, 'sessions', id), { recursive: true })
  writeFileSync(
    join(directory, 'sessions', id, 'history.json'),
    JSON.stringify({ snapshots: [{ id: 'saved-copy', generation, expiresAt: Date.now() + 60000, lines: ['line 100', 'line 101', 'line 102'] }] }),
    { mode: 0o600 },
  )
  const store = openBrowserAuthStore(join(directory, 'auth.sqlite'))
  const origin = 'http://localhost:43830'
  const auth = createBrowserAuth({ origin, rpId: 'localhost', store, now: Date.now, surface: { _tag: 'TerminalHost' }, bootstrapKind: 'pairing', bootstrap: () => false })
  store.addCredential({ id: 'credential', label: 'Fixture', created: Date.now(), credential: { id: 'credential', publicKey: new Uint8Array([1]), counter: 0 } })
  const cookie = auth.issueSession('credential').split(';')[0]!
  const api = createTerminalServer({
    manager: { directory, intent: () => ({ session: { id, generation, state: 'Exited' }, helperToken: 'fixture' }) } as never,
    origin,
    browserAuth: auth,
    now: Date.now,
    log: () => {},
  })
  api.server.listen(43830, '127.0.0.1')
  await once(api.server, 'listening')
  const socket = new WebSocket(`ws://localhost:43830/api/terminal/sessions/${id}/stream`, { headers: { origin, cookie } })
  const received: unknown[] = []
  socket.on('message', bytes => received.push(JSON.parse(bytes.toString())))
  try {
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'Attach', protocol: 1, viewId: 'reader', generation }))
    socket.send(JSON.stringify({ type: 'History', requestId: 'restore', snapshot: 'saved-copy', offset: 1, limit: 2 }))
    await expect.poll(() => received).toContainEqual(expect.objectContaining({
      type: 'History',
      requestId: 'restore',
      result: { _tag: 'Page', snapshot: 'saved-copy', total: 3, offset: 1, lines: ['line 101', 'line 102'] },
    }))
  }
  finally {
    socket.terminate()
    await api.close()
    store.close()
    rmSync(directory, { recursive: true })
  }
})

it.each(['logout', 'credentials/remove', 'expiry'])('revokes established terminal input and output after %s', async (action) => {
  const proof = await fixture()
  try {
    await once(proof.socket, 'open')
    await delay(30)
    const screens: string[] = []
    proof.socket.on('message', bytes => screens.push(bytes.toString()))
    if (action === 'expiry')
      proof.advance()
    else
      expect((await proof.action(action, { id: 'credential' }))?.status).toBe(200)
    proof.output()
    if (proof.socket.readyState === WebSocket.OPEN)
      proof.socket.send(JSON.stringify({ type: 'AcquireWriter' }))
    await delay(80)
    expect(proof.forwarded).toEqual([])
    expect(screens).toEqual([])
    expect(proof.socket.readyState).toBe(WebSocket.CLOSED)
  }
  finally {
    await proof.close()
  }
})

it('preserves a machine-authorized terminal after browser logout', async () => {
  const proof = await fixture(true)
  try {
    await once(proof.socket, 'open')
    await delay(30)
    await proof.action('logout')
    proof.socket.send(JSON.stringify({ type: 'AcquireWriter' }))
    await delay(30)
    expect(proof.forwarded.join('')).toContain('AcquireWriter')
    expect(proof.socket.readyState).toBe(WebSocket.OPEN)
  }
  finally {
    await proof.close()
  }
})

it('refuses a browser session revoked during asynchronous machine authorization', async () => {
  const proof = await fixture(false, true)
  try {
    const failure = await once(proof.socket, 'error')
    expect(String(failure[0])).toContain('403')
    expect(proof.forwarded).toEqual([])
  }
  finally {
    await proof.close()
  }
})
