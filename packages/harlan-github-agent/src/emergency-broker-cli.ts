import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import process from 'node:process'
import { createEmergencyBroker, parseEmergencyPins } from './emergency-broker.ts'
import { queueEmergencyPowerOff } from './emergency-poweroff.ts'

const pinsPath = '/etc/hogwild-emergency/public-passkeys.json'
const stateDirectory = '/var/lib/hogwild-emergency'
const countersPath = `${stateDirectory}/passkey-counters.json`
function privateRootPath(path: string, directory = false) {
  const info = lstatSync(path)
  if (info.uid !== 0 || (info.mode & 0o077) !== 0 || (directory ? !info.isDirectory() : !info.isFile()))
    throw new Error('Emergency configuration must be private and root owned.')
}
if (process.getuid?.() !== 0 || process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== '1')
  throw new Error('Use the root-owned emergency broker socket unit.')
privateRootPath('/etc/hogwild-emergency', true)
privateRootPath(pinsPath)
privateRootPath(stateDirectory, true)
const pins = parseEmergencyPins(JSON.parse(readFileSync(pinsPath, 'utf8')))
const counters: Record<string, number> = Object.create(null)
if (existsSync(countersPath)) {
  privateRootPath(countersPath)
  const stored = JSON.parse(readFileSync(countersPath, 'utf8')) as Record<string, unknown>
  for (const key of pins.credentials) {
    const counter = stored[key.id]
    if (counter !== undefined && (!Number.isSafeInteger(counter) || Number(counter) < 0))
      throw new Error('Invalid saved Passkey counter.')
    key.counter = Math.max(key.counter, Number(counter ?? 0))
    counters[key.id] = key.counter
  }
}
function control(action: 'check' | 'isolate') {
  const result = spawnSync('/usr/bin/node', ['/opt/hogwild-emergency/emergency.mjs', action, ...(action === 'isolate' ? ['--confirm=ISOLATE-HOGWILD'] : [])], {
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' },
    timeout: 20_000,
    encoding: 'utf8',
    maxBuffer: 65536,
  })
  if (result.error || result.status !== 0)
    throw new Error('Emergency controller refused request.')
}
const handle = createEmergencyBroker({
  pins,
  now: Date.now,
  check: () => control('check'),
  locked: () => existsSync(`${stateDirectory}/requested.json`),
  isolate: () => control('isolate'),
  poweroff: () => queueEmergencyPowerOff((file, args) => {
    const result = spawnSync(file, args, { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' }, timeout: 10_000, maxBuffer: 65536 })
    if (result.error || result.status !== 0)
      throw new Error('Power off could not be queued.')
  }),
  persistCounter(id, counter) {
    counters[id] = counter
    const temporary = `${countersPath}.next`
    const fd = openSync(temporary, 'w', 0o600)
    try {
      writeFileSync(fd, JSON.stringify(counters))
      fsyncSync(fd)
    }
    finally { closeSync(fd) }
    renameSync(temporary, countersPath)
    const directory = openSync(stateDirectory, 'r')
    try {
      fsyncSync(directory)
    }
    finally {
      closeSync(directory)
    }
  },
})
const server = createServer(async (request, response) => {
  try {
    const path = request.url
    if (!((path === '/status' && request.method === 'GET') || ((path === '/options' || path === '/isolate' || path === '/poweroff-options' || path === '/poweroff') && request.method === 'POST'))) {
      response.writeHead(404).end()
      return
    }
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      size += chunk.length
      if (size > 65536) {
        response.writeHead(413).end()
        return
      }
      chunks.push(chunk)
    }
    const result = await handle(path.slice(1), size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
    response.writeHead(result.status, Object.fromEntries(result.headers)).end(await result.text())
  }
  catch { response.writeHead(400).end() }
})
server.requestTimeout = 10_000
server.headersTimeout = 10_000
server.maxConnections = 16
server.listen({ fd: 3 })
