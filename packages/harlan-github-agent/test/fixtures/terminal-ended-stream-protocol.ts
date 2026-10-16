import type { TerminalIntent } from '../../src/terminal-storage.ts'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { get } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTerminalServer } from '../../src/terminal.ts'

const directory = await mkdtemp(join(tmpdir(), 'terminal-stream-protocol-'))
const sessionId = '123456789012345678901234'
const messages: string[] = []
function unexpected(): never {
  throw new Error('Unexpected terminal manager operation')
}
const api = createTerminalServer({
  manager: {
    directory,
    intent: () => ({ session: { id: sessionId, state: process.argv[2] } }) as TerminalIntent,
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
const socket = connect(address.port, '127.0.0.1')
try {
  await once(socket, 'connect')
  const handshake = once(socket, 'data')
  socket.write([
    `GET /api/terminal/sessions/${sessionId}/stream HTTP/1.1`,
    'Host: localhost',
    'Origin: http://localhost',
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    '',
    '',
  ].join('\r\n'))
  const [response] = await handshake
  if (!response.toString().startsWith('HTTP/1.1 101'))
    throw new Error(`Upgrade refused: ${response}`)
  const frames: Buffer[] = []
  socket.on('data', (bytes: Buffer) => frames.push(bytes))
  // RSV1 is forbidden because per-message compression was not negotiated.
  const closed = once(socket, 'close')
  socket.write(Buffer.from([0xC1, 0x80, 0, 0, 0, 0]))
  await closed
  const health = await new Promise<{ status: number | undefined, body: unknown }>((resolve, reject) => {
    get({ hostname: '127.0.0.1', port: address.port, path: '/health', headers: { host: 'localhost', connection: 'close' } }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', bytes => body += bytes)
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }))
      response.on('error', reject)
    }).on('error', reject)
  })
  const closeFrame = Buffer.concat(frames)
  console.log(JSON.stringify({
    status: health.status,
    health: health.body,
    closeCode: closeFrame.length >= 4 ? closeFrame.readUInt16BE(2) : null,
    messages,
  }))
}
finally {
  socket.destroy()
  await api.close()
  await rm(directory, { recursive: true, force: true })
}
