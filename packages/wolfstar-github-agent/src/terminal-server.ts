import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { BrowserAuth } from './browser-auth.ts'
import type { TerminalManager } from './terminal-manager.ts'
import type { TerminalIntent } from './terminal-storage.ts'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, relative } from 'node:path'
import { WebSocketServer } from 'ws'
import { openBrowserAuthStore } from './browser-auth-store.ts'
import { createBrowserAuth } from './browser-auth.ts'
import { connectTerminalHelper } from './terminal-helper-client.ts'
import {
  parseTerminalClientMessage,
  parseTerminalForce,
  parseTerminalJson,
  parseTerminalStart,
} from './terminal-protocol.ts'

export function createTerminalServer(options: {
  manager: TerminalManager
  origin: string
  origins?: string[]
  active?: () => boolean
  shutdownGraceMs?: number
  observer?: {
    handles: (path: string) => boolean
    handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  }
  staticDirectory?: string
  authorize?: (request: IncomingMessage) => boolean | Promise<boolean>
  browserAuth?: BrowserAuth
  publicBrowserAuth?: BrowserAuth
  diff?: (intent: TerminalIntent, url: URL) => Promise<unknown>
  now: () => number
  log: (message: string, cause: unknown) => void
}) {
  const origins = new Set(options.origins ?? [options.origin])
  const hosts = new Set([...origins].map((origin) => new URL(origin).host))
  const pairCode = randomUUID() + randomUUID()
  const pairExpires = options.now() + 300000
  let pairConsumed = false
  let closed = false
  let closing: Promise<void> | undefined
  const transports = new Set<Socket>()
  const grace = options.shutdownGraceMs ?? 100
  if (!Number.isSafeInteger(grace) || grace < 0 || grace > 5000) throw new Error('Invalid terminal shutdown interval')
  function constant(a: string, b: string) {
    return Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
  }
  const canonical = new URL(options.origin)
  if (!options.authorize && canonical.hostname === '127.0.0.1') canonical.hostname = 'localhost'
  if (!options.authorize) {
    if (new URL(options.origin).hostname === '127.0.0.1') {
      origins.delete(options.origin)
      hosts.delete(new URL(options.origin).host)
    }
    origins.add(canonical.origin)
    hosts.add(canonical.host)
  }
  const authStore = options.browserAuth
    ? undefined
    : openBrowserAuthStore(join(options.manager.directory, 'browser-auth.sqlite'))
  function consumePair(value: unknown) {
    if (typeof value !== 'string' || pairConsumed || options.now() >= pairExpires || !constant(value, pairCode))
      return false
    pairConsumed = true
    return true
  }
  const browserAuth =
    options.browserAuth ??
    createBrowserAuth({
      origin: canonical.origin,
      rpId: canonical.hostname,
      store: authStore!,
      now: options.now,
      surface: { _tag: 'TerminalHost' },
      bootstrapKind: 'pairing',
      bootstrap: (body) => consumePair(body.token ?? body.code),
    })
  if (options.publicBrowserAuth && (!options.authorize || options.publicBrowserAuth.bootstrapKind !== 'passkey'))
    throw new Error('Public terminals require private Agent sessions and public Passkey-only login.')
  function authority(request: IncomingMessage) {
    return request.headers['x-wolfstar-agent-ingress'] === 'public' ? options.publicBrowserAuth : browserAuth
  }
  function browserSession(request: IncomingMessage) {
    const session = authority(request)?.session(requestHeaders(request))
    return request.headers['x-wolfstar-agent-ingress'] === 'public' && session?.credentialId === null ? null : session
  }
  function requestHeaders(request: IncomingMessage) {
    return new Headers(
      Object.entries(request.headers).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]],
      ),
    )
  }
  async function authenticated(request: IncomingMessage) {
    if (request.headers['x-wolfstar-agent-ingress'] === 'public') return Boolean(browserSession(request))
    return Boolean(browserAuth.session(requestHeaders(request))) || Boolean(await options.authorize?.(request))
  }
  function publicTransportRefused(request: IncomingMessage) {
    return (
      request.headers['x-wolfstar-agent-ingress'] === 'public' &&
      (request.headers.host !== canonical.host ||
        (request.headers.origin !== undefined && request.headers.origin !== canonical.origin))
    )
  }
  function json(response: ServerResponse, value: unknown, status = 200) {
    response
      .writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      })
      .end(JSON.stringify(value))
  }
  async function body(request: IncomingMessage) {
    let bytes = 0
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      bytes += chunk.length
      if (bytes > 128 * 1024) return { _tag: 'Err', reason: 'SizeLimit' } as const
      chunks.push(chunk)
    }
    return parseTerminalJson(Buffer.concat(chunks).toString('utf8'))
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((cause) => {
      options.log('Terminal request failed', cause)
      if (!response.headersSent) json(response, { _tag: 'Err', reason: 'SessionUnavailable' }, 503)
      else response.destroy()
    })
  })
  server.on('connection', (socket) => {
    transports.add(socket)
    socket.once('close', () => transports.delete(socket))
  })
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (!options.authorize && request.method === 'GET' && request.headers.host === `127.0.0.1:${canonical.port}`) {
      response.writeHead(307, { Location: `${canonical.origin}${request.url ?? '/'}` }).end()
      return
    }
    if (
      !request.headers.host ||
      publicTransportRefused(request) ||
      !hosts.has(request.headers.host) ||
      (request.headers.origin !== undefined && !origins.has(request.headers.origin)) ||
      (request.method !== 'GET' && (!request.headers.origin || !origins.has(request.headers.origin)))
    ) {
      json(response, { _tag: 'Err', reason: 'OriginRefused' }, 403)
      return
    }
    response.setHeader('X-Content-Type-Options', 'nosniff')
    const nonce = randomBytes(18).toString('base64')
    response.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    )
    const url = new URL(request.url ?? '/', options.origin)
    if (url.pathname.startsWith('/api/browser-auth/')) {
      const decoded = request.method === 'GET' ? undefined : await body(request)
      if (decoded?._tag === 'Err') {
        json(response, decoded, 400)
        return
      }
      const result = await browserAuth.handle(
        new Request(`${canonical.origin}${url.pathname}`, {
          method: request.method ?? 'GET',
          headers: requestHeaders(request),
          ...(decoded?._tag === 'Ok' ? { body: JSON.stringify(decoded.value) } : {}),
        }),
      )
      if (result) {
        for (const [name, value] of result.headers) {
          if (name !== 'set-cookie') response.setHeader(name, value)
        }
        response.setHeader('set-cookie', result.headers.getSetCookie())
        response.writeHead(result.status).end(await result.text())
      }
      return
    }
    if (closed || (options.active && !options.active())) {
      json(response, { _tag: 'Err', reason: 'OwnershipUnknown' }, 503)
      return
    }
    const prefix = '/api/terminal'
    if (url.pathname === `${prefix}/pair` && request.method === 'POST' && !options.authorize) {
      const parsed = await body(request)
      const code =
        parsed._tag === 'Ok' && typeof parsed.value === 'object' && parsed.value !== null && 'code' in parsed.value
          ? parsed.value.code
          : null
      if (!consumePair(code)) {
        json(response, { _tag: 'Err', reason: 'AuthenticationRequired' }, 401)
        return
      }
      response.setHeader('Set-Cookie', browserAuth.issueSession(null))
      json(response, { _tag: 'Ok', value: true })
      return
    }
    if (url.pathname.startsWith(prefix)) {
      if (!(await authenticated(request))) {
        json(response, { _tag: 'Err', reason: 'AuthenticationRequired' }, 401)
        return
      }
      if (request.method === 'GET' && url.pathname === `${prefix}/capabilities`) {
        json(response, options.manager.capabilities())
        return
      }
      if (request.method === 'GET' && url.pathname === `${prefix}/capacity`) {
        json(response, await options.manager.capacity())
        return
      }
      if (request.method === 'GET' && url.pathname === `${prefix}/projects`) {
        json(response, options.manager.projects())
        return
      }
      if (request.method === 'GET' && url.pathname === `${prefix}/sessions`) {
        json(response, await options.manager.sessions())
        return
      }
      if (request.method === 'POST' && url.pathname === `${prefix}/sessions`) {
        const decoded = await body(request)
        const launch = decoded._tag === 'Ok' ? parseTerminalStart(decoded.value) : decoded
        if (launch._tag === 'Ok' && launch.value._tag === 'ManualOverride' && !browserSession(request)) {
          json(response, { _tag: 'Err', reason: 'AuthenticationRequired' }, 401)
          return
        }
        json(
          response,
          launch._tag === 'Ok'
            ? launch.value._tag === 'ManualOverride'
              ? await options.manager.launchForce(launch.value.launch)
              : await options.manager.launch(launch.value.launch)
            : launch,
        )
        return
      }
      const force = /^\/api\/terminal\/sessions\/([a-f\d]{24})\/force$/.exec(url.pathname)
      if (request.method === 'POST' && force?.[1]) {
        if (!browserSession(request)) {
          json(response, { _tag: 'Err', reason: 'AuthenticationRequired' }, 401)
          return
        }
        const decoded = await body(request)
        const parsed = decoded._tag === 'Ok' ? parseTerminalForce(decoded.value) : decoded
        if (!browserSession(request)) {
          json(response, { _tag: 'Err', reason: 'AuthenticationRequired' }, 401)
          return
        }
        json(
          response,
          parsed._tag === 'Ok' ? await options.manager.forceQueued(force[1], parsed.value.requestId) : parsed,
        )
        return
      }
      const stop = /^\/api\/terminal\/sessions\/([a-f\d]{24})\/stop$/.exec(url.pathname)
      if (request.method === 'POST' && stop?.[1]) {
        json(response, await options.manager.stop(stop[1]))
        return
      }
      const diff = /^\/api\/terminal\/sessions\/([a-f\d]{24})\/diff(?:\/file)?$/.exec(url.pathname)
      if (request.method === 'GET' && diff?.[1] && options.diff) {
        const intent = options.manager.intent(diff[1])
        json(
          response,
          intent?.session.worktree ? await options.diff(intent, url) : { _tag: 'Err', reason: 'SessionUnavailable' },
        )
        return
      }
      json(response, { _tag: 'Err', reason: 'InvalidRequest' }, 404)
      return
    }
    if (options.observer?.handles(url.pathname)) {
      if (!(await authenticated(request))) {
        json(response, { _tag: 'Err', reason: 'AuthenticationRequired' }, 401)
        return
      }
      await options.observer.handle(request, response)
      return
    }
    if (request.method !== 'GET' || !options.staticDirectory) {
      response.writeHead(404).end()
      return
    }
    const root = await realpath(options.staticDirectory)
    let file = await realpath(join(root, decodeURIComponent(url.pathname))).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return join(root, 'index.html')
      throw cause
    })
    if ((await stat(file)).isDirectory()) file = await realpath(join(file, 'index.html'))
    const path = relative(root, file)
    if (path.startsWith('..') || path.startsWith('/')) {
      response.writeHead(403).end()
      return
    }
    const mime: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.wasm': 'application/wasm',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.woff2': 'font/woff2',
    }
    const bytes = await readFile(file)
    const asset =
      extname(file) === '.html'
        ? bytes.toString('utf8').replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`)
        : bytes
    if (extname(file) === '.html') response.setHeader('Cache-Control', 'no-store')
    response
      .writeHead(200, {
        'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
      })
      .end(asset)
  }
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 128 * 1024,
    perMessageDeflate: false,
  })
  server.on('upgrade', (request, socket, head) => {
    void upgrade(request, socket, head).catch((cause) => {
      options.log('Terminal attachment failed', cause)
      socket.destroy()
    })
  })
  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    type Principal = { _tag: 'Machine' } | { _tag: 'Browser'; hash: string }
    const machine =
      request.headers['x-wolfstar-agent-ingress'] !== 'public' && Boolean(await options.authorize?.(request))
    const auth = authority(request)
    const session = browserSession(request)
    const principal: Principal | null = machine
      ? { _tag: 'Machine' }
      : session
        ? { _tag: 'Browser', hash: session.hash }
        : null
    const browserAccess = () =>
      principal?._tag === 'Machine' ||
      (principal?._tag === 'Browser' && browserSession(request)?.hash === principal.hash)
    if (
      closed ||
      (options.active && !options.active()) ||
      !request.headers.host ||
      publicTransportRefused(request) ||
      !hosts.has(request.headers.host) ||
      !request.headers.origin ||
      !origins.has(request.headers.origin) ||
      !principal ||
      !browserAccess()
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n', () => socket.destroy())
      return
    }
    const match = /^\/api\/terminal\/sessions\/([a-f\d]{24})\/stream$/.exec(
      new URL(request.url ?? '/', options.origin).pathname,
    )
    const intent = match?.[1] ? options.manager.intent(match[1]) : undefined
    if (!intent || intent.session.state !== 'Running' || sockets.clients.size >= 32) {
      socket.end('HTTP/1.1 409 Conflict\r\n\r\n', () => socket.destroy())
      return
    }
    if (!browserAccess()) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n', () => socket.destroy())
      return
    }
    sockets.handleUpgrade(request, socket, head, (websocket) => {
      const expired = () => {
        helper.close()
        websocket.close(1008, 'Authentication required')
      }
      const revoke = auth?.onSessionRevocation((hash) => {
        if (principal._tag === 'Browser' && hash === principal.hash) expired()
      })
      const expiry =
        principal._tag === 'Browser'
          ? setInterval(() => {
              if (!browserAccess()) expired()
            }, 1000)
          : undefined
      expiry?.unref()
      const helper = connectTerminalHelper({
        directory: options.manager.directory,
        intent,
        message: (message) => {
          if (!browserAccess()) {
            expired()
            return
          }
          if (websocket.bufferedAmount > 8 * 1024 * 1024) {
            websocket.close(1013, 'Reconnect to receive the current screen')
            return
          }
          websocket.send(JSON.stringify(message))
        },
        closed: () => {
          if (websocket.readyState === websocket.OPEN) websocket.close(1011, 'Terminal owner unavailable')
        },
      })
      websocket.on('message', (bytes) => {
        if (!browserAccess()) {
          expired()
          return
        }
        if (closed || (options.active && !options.active())) {
          helper.close()
          websocket.terminate()
          return
        }
        const decoded = parseTerminalJson(bytes.toString())
        const parsed = decoded._tag === 'Ok' ? parseTerminalClientMessage(decoded.value) : decoded
        if (parsed._tag === 'Err') {
          websocket.send(JSON.stringify({ type: 'Failure', reason: parsed.reason }))
        } else if (!helper.send(parsed.value)) {
          websocket.send(JSON.stringify({ type: 'Failure', reason: 'DeliveryUnknown' }))
        }
      })
      websocket.on('error', (cause) => options.log('Terminal stream failed', cause))
      websocket.on('close', () => {
        revoke?.()
        if (expiry) clearInterval(expiry)
      })
      websocket.on('close', () => helper.close())
    })
  }
  return {
    server,
    handle,
    upgrade,
    handles: (path: string) =>
      (!options.authorize && path.startsWith('/api/browser-auth/')) ||
      path === '/api/terminal' ||
      path.startsWith('/api/terminal/') ||
      Boolean(options.observer?.handles(path)),
    pairCode,
    pairingUrl: `${canonical.origin}/#pair=${pairCode}`,
    sockets,
    close() {
      if (closing) return closing
      closed = true
      closing = new Promise<void>((resolve) => {
        let httpClosed = false
        let streamsClosed = false
        const force = () => {
          for (const client of sockets.clients) client.terminate()
          for (const transport of transports) transport.destroy()
        }
        const timer = setTimeout(force, grace)
        timer.unref()
        const finish = () => {
          if (!httpClosed || !streamsClosed) return
          clearTimeout(timer)
          authStore?.close()
          resolve()
        }
        for (const client of sockets.clients) client.close(1001, 'Terminal API restarting')
        sockets.close(() => {
          streamsClosed = true
          finish()
        })
        server.close(() => {
          httpClosed = true
          finish()
        })
      })
      return closing
    },
  }
}
