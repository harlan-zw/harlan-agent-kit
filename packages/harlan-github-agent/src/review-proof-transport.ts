import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ReviewProofResult } from './review-proof.ts'
import { Buffer } from 'node:buffer'
import { createServer, request } from 'node:http'
import { redactSecrets } from './agent-activity.ts'

const maximumMessageBytes = 128_000

/** Exposes only the fixed proof plan. The controller ledger remains outside all worker mounts. */
export async function serveReviewProof(socketPath: string, run: (input: unknown) => Promise<ReviewProofResult>): Promise<{ close: () => Promise<void> }> {
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST' || request.url !== '/proof') {
      response.writeHead(404).end()
      return
    }
    let bytes = 0
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      bytes += chunk.length
      if (bytes > maximumMessageBytes) {
        response.writeHead(413).end()
        return
      }
      chunks.push(Buffer.from(chunk))
    }
    let input: unknown
    try {
      input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    }
    catch {
      response.writeHead(400).end('The proof request must contain JSON.')
      return
    }
    const result = await run(input).catch((error: unknown) => ({ _tag: 'TransportFailed', reason: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500) }))
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
  }
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000 }, (request, response) => {
    void handle(request, response).catch((error: unknown) => {
      response.writeHead(500).end(JSON.stringify({ _tag: 'TransportFailed', reason: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500) }))
    })
  })
  // Malformed or disconnected clients have no proof effect. Close their connection.
  server.on('clientError', (_error, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  return { close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

export function requestReviewProof(socketPath: string, input: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = request({ socketPath, path: '/proof', method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 45_000 }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
        if (Buffer.byteLength(body) > maximumMessageBytes)
          response.destroy(new Error('The proof receipt exceeds its byte limit.'))
      })
      response.once('error', reject)
      response.once('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error('The controller refused the proof transport request.'))
          return
        }
        try {
          resolve(JSON.parse(body) as unknown)
        }
        catch {
          reject(new Error('The controller proof receipt must contain JSON.'))
        }
      })
    })
    client.once('timeout', () => client.destroy(new Error('The proof transport timed out.')))
    client.once('error', reject)
    client.end(JSON.stringify(input))
  })
}
