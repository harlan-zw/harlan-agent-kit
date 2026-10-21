import type { Result } from './types.ts'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

export interface WebhookRequest {
  deliveryId: string
  event: string
  signature: string
  body: string
}

export interface ServerOptions {
  host?: string
  port?: number
  webhookSecret: string | null
  bodyBytes?: number
  requestsPerMinute?: number
  readiness?: () => boolean | Promise<boolean>
  handleWebhook: (request: WebhookRequest) => Promise<Result<unknown>>
  onError?: (error: unknown) => void
}

export interface WebhookServer {
  url: string
  close: () => Promise<void>
}

export async function startServer(options: ServerOptions): Promise<WebhookServer> {
  if (options.webhookSecret !== null && options.webhookSecret.length < 16)
    throw new Error('The webhook secret must contain at least 16 characters.')
  const bodyBytes = options.bodyBytes ?? 2097152
  const requestsPerMinute = options.requestsPerMinute ?? 300
  const host = options.host ?? '127.0.0.1'
  let count = 0
  let windowStarted = Date.now()
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 1000 }, (request, response) => {
    const send = (status: number, data: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      response.end(JSON.stringify(data))
    }
    const handle = async () => {
      if (request.method === 'GET' && request.url === '/healthz') {
        send(200, { status: 'alive' })
        return
      }
      if (request.method === 'GET' && request.url === '/readyz') {
        const ready = await options.readiness?.() ?? true
        send(ready ? 200 : 503, { status: ready ? 'ready' : 'waiting' })
        return
      }
      if (request.url !== '/webhooks/github') {
        send(404, { error: 'Route not found.' })
        return
      }
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        send(405, { error: 'Use POST for GitHub webhooks.' })
        return
      }
      if (options.webhookSecret === null) {
        send(503, { error: 'Webhook ingestion is disabled. Configure the webhook secret to enable it.' })
        return
      }
      const now = Date.now()
      if (now - windowStarted >= 60000) {
        count = 0
        windowStarted = now
      }
      if (++count > requestsPerMinute) {
        response.setHeader('retry-after', String(Math.max(1, Math.ceil((60000 - (now - windowStarted)) / 1000))))
        send(429, { error: 'Request limit reached. Retry after the indicated delay.' })
        return
      }
      const contentType = request.headers['content-type']?.split(';')[0]?.trim()
      if (contentType !== 'application/json' || (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) {
        send(415, { error: 'Send an uncompressed application/json body.' })
        return
      }
      const deliveryId = request.headers['x-github-delivery']
      const event = request.headers['x-github-event']
      const signature = request.headers['x-hub-signature-256']
      if (typeof deliveryId !== 'string' || !/^[\w-]{1,128}$/.test(deliveryId) || typeof event !== 'string' || !/^[a-z_]{1,100}$/.test(event) || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
        send(400, { error: 'Provide valid GitHub delivery, event, and signature headers.' })
        return
      }
      const contentLength = request.headers['content-length']
      if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > bodyBytes)) {
        send(413, { error: 'Webhook body exceeds the configured limit.' })
        request.resume()
        return
      }
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        length += bytes.length
        if (length > bodyBytes) {
          send(413, { error: 'Webhook body exceeds the configured limit.' })
          return
        }
        chunks.push(bytes)
      }
      const body = Buffer.concat(chunks)
      const expected = createHmac('sha256', options.webhookSecret).update(body).digest()
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) {
        send(401, { error: 'Webhook signature did not match.' })
        return
      }
      const text = body.toString('utf8')
      // JSON.parse rejects malformed input. Keep the original bytes for the adapter's signature and normalization checks.
      const parsed = await Promise.resolve().then(() => JSON.parse(text) as unknown).then(() => true).catch(() => false)
      if (!parsed) {
        send(400, { error: 'Webhook body contains invalid JSON.' })
        return
      }
      const accepted = await options.handleWebhook({ deliveryId, event, signature, body: text })
      if (accepted._tag === 'Err') {
        send(accepted.error._tag === 'Authorization' ? 403 : accepted.error._tag === 'Configuration' || accepted.error._tag === 'Permanent' ? 400 : 503, { error: 'Webhook was not accepted. Check the Octorun logs before retrying.' })
        return
      }
      send(202, { accepted: true })
    }
    void handle().catch((error: unknown) => {
      options.onError?.(error)
      if (!response.headersSent)
        send(503, { error: 'Webhook ingestion failed. Retry after checking Octorun.' })
      else
        response.end()
    })
  })
  server.maxConnections = 128
  server.maxRequestsPerSocket = 100
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 3333, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Could not read the webhook server address.')
  const hostname = address.family === 'IPv6' ? `[${address.address}]` : address.address
  return {
    url: `http://${hostname}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeIdleConnections()
    }),
  }
}
