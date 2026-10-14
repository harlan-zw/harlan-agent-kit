import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const caddy = spawnSync('caddy', ['version'], { stdio: 'ignore' }).status === 0
it.skipIf(!caddy)('refuses foreign WebSocket origins before translating the public terminal origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'public-terminal-proxy-'))
  const received: unknown[] = []
  const backend = createServer((request, response) => {
    received.push(request.headers)
    response.writeHead(200).end('accepted')
  })
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve))
  const backendAddress = backend.address()
  if (!backendAddress || typeof backendAddress === 'string') throw new Error('Expected TCP listener')
  const reserve = createServer()
  await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve))
  const proxyAddress = reserve.address()
  if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Expected TCP listener')
  await new Promise<void>((resolve) => reserve.close(() => resolve()))
  const template = await readFile(new URL('../../../scripts/30-agent.caddy', import.meta.url), 'utf8')
  const config = join(directory, 'Caddyfile')
  await writeFile(
    config,
    `{\nadmin off\nauto_https off\n}\nhttp://:${proxyAddress.port} {\nbind 127.0.0.1\n${template.replace('127.0.0.1:3210', `127.0.0.1:${backendAddress.port}`)}\n}\n`,
  )
  const proxy = spawn('caddy', ['run', '--config', config, '--adapter', 'caddyfile'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const ready = new Promise<void>((resolve, reject) => {
    proxy.stderr.on('data', (bytes) => {
      if (bytes.toString().includes('serving initial configuration')) resolve()
    })
    proxy.once('error', reject)
    proxy.once('exit', () => reject(new Error('Caddy exited before readiness')))
  })
  const get = (path: string, origin?: string, upgrade = false) =>
    new Promise<number>((resolve, reject) => {
      const call = request(
        `http://127.0.0.1:${proxyAddress.port}${path}`,
        {
          headers: {
            host: 'agent.harlanzw.com',
            ...(origin ? { origin } : {}),
            ...(upgrade ? { connection: 'Upgrade', upgrade: 'WebSocket' } : {}),
          },
        },
        (response) => {
          response.resume()
          resolve(response.statusCode ?? 500)
        },
      )
      call.once('error', reject)
      call.end()
    })
  try {
    await ready
    for (const origin of [undefined, 'https://evil.example.com', 'https://hogwild.tailcad325.ts.net'])
      expect(await get('/api/terminal/sessions/example/stream', origin, true)).toBe(403)
    expect(received).toEqual([])
    expect(await get('/api/terminal/sessions/example/stream', 'https://agent.harlanzw.com', true)).toBe(200)
    expect(received).toEqual([
      expect.objectContaining({
        host: 'hogwild.tailcad325.ts.net',
        origin: 'https://hogwild.tailcad325.ts.net',
        'x-wolfstar-agent-ingress': 'public',
      }),
    ])
    for (const path of ['/api/sessions', '/api/desktop/sessions/report', '/api/items/pull-request-diff'])
      expect(await get(path, 'https://agent.harlanzw.com')).toBe(403)
  } finally {
    proxy.kill('SIGTERM')
    await new Promise<void>((resolve) => backend.close(() => resolve()))
    await rm(directory, { recursive: true })
  }
})
