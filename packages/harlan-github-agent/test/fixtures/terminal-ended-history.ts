import type { TerminalIntent } from '../../src/terminal-storage.ts'
import { once } from 'node:events'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { writeTerminalHistory } from '../../src/terminal-history.ts'
import { createTerminalServer } from '../../src/terminal.ts'

const directory = await mkdtemp(join(tmpdir(), 'terminal-ended-history-'))
const sessionId = '123456789012345678901234'
const generation = 'generation'
const messages: string[] = []
const history = join(directory, 'sessions', sessionId, 'history.json')
await mkdir(join(history, '..'), { recursive: true })
writeTerminalHistory(directory, sessionId, [
  { id: 'saved', generation, expiresAt: Date.now() + 60000, lines: ['saved output'] },
])
await rename(history, `${history}.saved`)
await mkdir(history)
function unexpected(): never {
  throw new Error('Unexpected terminal manager operation')
}
const api = createTerminalServer({
  manager: {
    directory,
    intent: () => ({ session: { id: sessionId, generation, state: process.argv[2] } }) as TerminalIntent,
    host: { bootId: 'boot', hostId: 'host', authSecret: 'fixture' },
    capacity: unexpected,
    close: unexpected,
    retryQueued: unexpected,
    forceQueued: unexpected,
    launchForce: unexpected,
    capabilities: unexpected,
    projects: unexpected,
    sessions: unexpected,
    launch: unexpected,
    stop: unexpected,
  },
  origin: 'http://localhost',
  authorize: () => true,
  observer: {
    handles: path => path === '/health',
    handle: async (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ alive: true }))
    },
  },
  now: Date.now,
  log: message => messages.push(message),
})
api.server.listen(0, '127.0.0.1')
await once(api.server, 'listening')
const address = api.server.address()
if (!address || typeof address === 'string')
  throw new Error('Missing server address')
const websocket = new WebSocket(`ws://127.0.0.1:${address.port}/api/terminal/sessions/${sessionId}/stream`, {
  origin: 'http://localhost',
  headers: { host: 'localhost' },
})
async function request(value: unknown) {
  const response = once(websocket, 'message')
  websocket.send(JSON.stringify(value))
  const [bytes] = await response
  return JSON.parse(bytes.toString())
}
try {
  await once(websocket, 'open')
  const attached = await request({ type: 'Attach', protocol: 1, generation, viewId: 'reader' })
  if (attached.type !== 'Attached')
    throw new Error(`Attach failed: ${JSON.stringify(attached)}`)
  const failed = await request({ type: 'History', requestId: 'failed', snapshot: 'saved', offset: 0, limit: 10 })
  const health = await new Promise<{ status: number | undefined, body: unknown }>((resolve, reject) => {
    get({ hostname: '127.0.0.1', port: address.port, path: '/health', headers: { host: 'localhost', connection: 'close' } }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', bytes => body += bytes)
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }))
      response.on('error', reject)
    }).on('error', reject)
  })
  await rm(history, { recursive: true })
  await rename(`${history}.saved`, history)
  const recovered = await request({ type: 'History', requestId: 'retry', snapshot: 'saved', offset: 0, limit: 10 })
  console.log(JSON.stringify({ failed, recovered, status: health.status, health: health.body, messages }))
}
finally {
  websocket.terminate()
  await api.close()
  await rm(directory, { recursive: true, force: true })
}
