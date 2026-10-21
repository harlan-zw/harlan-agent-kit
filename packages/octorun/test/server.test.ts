import { createHmac } from 'node:crypto'
import { request } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { startServer } from '../src/server.ts'

const servers: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
})
const secret = 'a-long-webhook-secret-for-local-tests'
const sign = (body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
const headers = (body: string) => ({ 'content-type': 'application/json', 'x-github-delivery': 'delivery-123', 'x-github-event': 'ping', 'x-hub-signature-256': sign(body) })

it('persists authenticated webhook input before returning accepted', async () => {
  const calls: unknown[] = []
  const server = await startServer({ port: 0, webhookSecret: secret, handleWebhook: async (input) => {
    calls.push(input)
    return { _tag: 'Ok', value: { accepted: 1 } }
  } })
  servers.push(server)
  const body = '{"zen":"keep it simple"}'
  const response = await fetch(`${server.url}/webhooks/github`, { method: 'POST', headers: headers(body), body })
  expect(response.status).toBe(202)
  expect(calls).toEqual([{ deliveryId: 'delivery-123', event: 'ping', signature: sign(body), body }])
})

it('rejects invalid signatures before invoking ingestion', async () => {
  const calls: unknown[] = []
  const server = await startServer({ port: 0, webhookSecret: secret, handleWebhook: async (input) => {
    calls.push(input)
    return { _tag: 'Ok', value: null }
  } })
  servers.push(server)
  const response = await fetch(`${server.url}/webhooks/github`, { method: 'POST', headers: { ...headers('{}'), 'x-hub-signature-256': sign('different') }, body: '{}' })
  expect(response.status).toBe(401)
  expect(calls).toEqual([])
})

it('bounds request bodies and rejects malformed JSON', async () => {
  const calls: unknown[] = []
  const server = await startServer({ port: 0, webhookSecret: secret, bodyBytes: 1024, handleWebhook: async (input) => {
    calls.push(input)
    return { _tag: 'Ok', value: null }
  } })
  servers.push(server)
  const big = JSON.stringify({ body: 'x'.repeat(2000) })
  expect((await fetch(`${server.url}/webhooks/github`, { method: 'POST', headers: headers(big), body: big })).status).toBe(413)
  expect((await fetch(`${server.url}/webhooks/github`, { method: 'POST', headers: headers('{'), body: '{' })).status).toBe(400)
  expect(calls).toEqual([])
})

it('exposes readiness without exposing operator control routes', async () => {
  const server = await startServer({ port: 0, webhookSecret: secret, readiness: async () => false, handleWebhook: async () => ({ _tag: 'Ok', value: null }) })
  servers.push(server)
  expect((await fetch(`${server.url}/healthz`)).status).toBe(200)
  expect((await fetch(`${server.url}/readyz`)).status).toBe(503)
  expect((await fetch(`${server.url}/cancel`, { method: 'POST' })).status).toBe(404)
})

it('returns retryable failure if durable ingestion fails', async () => {
  const server = await startServer({ port: 0, webhookSecret: secret, handleWebhook: async () => ({ _tag: 'Err', error: { _tag: 'Transient', message: 'sensitive internal path' } }) })
  servers.push(server)
  const response = await fetch(`${server.url}/webhooks/github`, { method: 'POST', headers: headers('{}'), body: '{}' })
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain('sensitive')
})

it('limits webhook request admission', async () => {
  const server = await startServer({ port: 0, webhookSecret: secret, requestsPerMinute: 1, handleWebhook: async () => ({ _tag: 'Ok', value: null }) })
  servers.push(server)
  expect((await fetch(`${server.url}/webhooks/github`, { method: 'POST', headers: headers('{}'), body: '{}' })).status).toBe(202)
  const response = await fetch(`${server.url}/webhooks/github`, { method: 'POST', headers: headers('{}'), body: '{}' })
  expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBeTruthy()
})

it('bounds a chunked body without relying on Content-Length', async () => {
  const calls: unknown[] = []
  const server = await startServer({ port: 0, webhookSecret: secret, bodyBytes: 1024, handleWebhook: async (input) => {
    calls.push(input)
    return { _tag: 'Ok', value: null }
  } })
  servers.push(server)
  const body = JSON.stringify({ body: 'x'.repeat(2000) })
  const status = await new Promise<number>((resolve, reject) => {
    const incoming = request(`${server.url}/webhooks/github`, { method: 'POST', headers: headers(body) }, (response) => {
      response.resume()
      resolve(response.statusCode!)
    })
    incoming.once('error', reject)
    incoming.write(body.slice(0, 800))
    incoming.end(body.slice(800))
  })
  expect(status).toBe(413)
  expect(calls).toEqual([])
})
