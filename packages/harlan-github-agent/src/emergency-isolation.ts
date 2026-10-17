import { request } from 'node:http'

export const emergencySocket = '/run/hogwild-emergency-broker.sock'
export type EmergencyOperation = 'status' | 'options' | 'isolate' | 'poweroff-options' | 'poweroff'
export type EmergencyProxy = (operation: EmergencyOperation, body?: unknown) => Promise<Response>

/** Fixed Unix socket and operations: this bridge conveys no shell or recovery authority. */
export const emergencyIsolationRequest: EmergencyProxy = (operation, body) => new Promise((resolve, reject) => {
  const serialized = body === undefined ? undefined : JSON.stringify(body)
  const outgoing = request({ socketPath: emergencySocket, path: `/${operation}`, method: operation === 'status' ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, timeout: 20_000 }, (incoming) => {
    const chunks: Buffer[] = []
    let size = 0
    incoming.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 65536)
        outgoing.destroy(new Error('Emergency response exceeds limit.'))
      else chunks.push(chunk)
    })
    incoming.on('error', reject)
    incoming.on('end', () => resolve(new Response(Buffer.concat(chunks).toString('utf8'), { status: incoming.statusCode ?? 502, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })))
  })
  outgoing.on('timeout', () => outgoing.destroy(new Error('Emergency request timed out.')))
  outgoing.on('error', reject)
  outgoing.end(serialized)
})
