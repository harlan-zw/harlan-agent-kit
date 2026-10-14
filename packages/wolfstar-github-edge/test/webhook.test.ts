import type { WebhookDelivery } from '../src/env.ts'
import { describe, expect, it } from 'vitest'
import { handleQueue, handleRequest } from '../src/app.ts'
import { MAXIMUM_INLINE_BYTES, retryDelaySeconds } from '../src/webhook.ts'
import { ORIGIN, READY_SETUP, createTestEdge, sign } from './fixtures.ts'

const DELIVERY = '72d3162e-cc78-11e3-81ab-4c9367dc0958'

async function deliver(body: string, headers: Record<string, string> = {}): Promise<Request> {
  return new Request(`${ORIGIN}/webhook`, {
    method: 'POST',
    headers: {
      'x-github-delivery': DELIVERY,
      'x-github-event': 'pull_request',
      'x-hub-signature-256': await sign(body),
      ...headers,
    },
    body,
  })
}

interface RecordedMessage {
  body: WebhookDelivery
  attempts: number
  acked: boolean
  retriedAfter: number | null
}

function batchOf(messages: WebhookDelivery[], attempts = 1) {
  const recorded: RecordedMessage[] = messages.map((body) => ({ body, attempts, acked: false, retriedAfter: null }))
  const batch = {
    messages: recorded.map((entry) => ({
      body: entry.body,
      attempts: entry.attempts,
      ack: () => {
        entry.acked = true
      },
      retry: (options?: { delaySeconds?: number }) => {
        entry.retriedAfter = options?.delaySeconds ?? 0
      },
    })),
  } as unknown as MessageBatch<WebhookDelivery>
  return { batch, recorded }
}

describe('webhook intake', () => {
  it('queues a signed delivery and answers 204 before the controller sees it', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })
    const body = JSON.stringify({ repository: { full_name: 'wolfstar-project/plugins' } })

    const response = await handleRequest(await deliver(body), edge.dependencies)

    expect(response.status).toBe(204)
    expect(edge.sent).toEqual([
      { delivery: DELIVERY, event: 'pull_request', signature: await sign(body), body: { _tag: 'Inline', text: body } },
    ])
    expect(edge.relayed).toHaveLength(0)
  })

  it('answers 503 before setup created the App, because there is no secret to verify with', async () => {
    const edge = createTestEdge()

    expect((await handleRequest(await deliver('{}'), edge.dependencies)).status).toBe(503)
    expect(edge.sent).toHaveLength(0)
  })

  it('rejects a wrong, missing, or malformed signature without queueing', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    for (const signature of [await sign('{}', 'another-secret'), 'sha256=nothex', '']) {
      const response = await handleRequest(await deliver('{}', { 'x-hub-signature-256': signature }), edge.dependencies)
      expect(response.status).toBe(401)
    }
    expect(edge.sent).toHaveLength(0)
  })

  it('rejects a delivery identity that is missing or unsafe as a storage key', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    for (const delivery of ['', '../escape', 'a'.repeat(129)]) {
      const response = await handleRequest(await deliver('{}', { 'x-github-delivery': delivery }), edge.dependencies)
      expect(response.status).toBe(400)
    }
    expect(edge.sent).toHaveLength(0)
  })

  it('moves a body too large for a Queue message into R2', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })
    const body = JSON.stringify({ padding: 'x'.repeat(MAXIMUM_INLINE_BYTES) })

    expect((await handleRequest(await deliver(body), edge.dependencies)).status).toBe(204)

    expect(edge.sent[0]?.body).toEqual({ _tag: 'Stored', key: `deliveries/${DELIVERY}` })
    expect(edge.objects.get(`deliveries/${DELIVERY}`)).toBe(body)
  })

  it('serves only POST on the exact webhook path', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    expect((await handleRequest(new Request(`${ORIGIN}/webhook`), edge.dependencies)).status).toBe(405)
    // `/webhook/` belongs to the dashboard, which keeps its own authentication.
    await handleRequest(new Request(`${ORIGIN}/webhook/`), edge.dependencies)
    expect(edge.dashboard.map((call) => call.url)).toEqual(['http://wolfstar-github-agent.localhost/webhook/'])
  })
})

describe('webhook relay', () => {
  const message: WebhookDelivery = {
    delivery: DELIVERY,
    event: 'issues',
    signature: `sha256=${'0'.repeat(64)}`,
    body: { _tag: 'Inline', text: '{"action":"opened"}' },
  }

  it('forwards the original signature, event, and body to the controller', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })
    const { batch, recorded } = batchOf([message])

    await handleQueue(batch, edge.dependencies)

    expect(edge.relayed).toEqual([
      { delivery: DELIVERY, event: 'issues', signature: message.signature, text: '{"action":"opened"}' },
    ])
    expect(recorded[0]).toMatchObject({ acked: true, retriedAfter: null })
  })

  it('retries with backoff while the controller is starting or failing', async () => {
    for (const relay of [
      async () => {
        throw new Error('container starting')
      },
      async () => 502,
      async () => 429,
    ]) {
      const edge = createTestEdge({ setup: READY_SETUP, relay })
      const { batch, recorded } = batchOf([message], 3)

      await handleQueue(batch, edge.dependencies)

      expect(recorded[0]).toMatchObject({ acked: false, retriedAfter: retryDelaySeconds(3) })
    }
  })

  it('drops a delivery the controller refuses, or one that arrives before setup is complete', async () => {
    for (const relay of [async () => 401, async () => null]) {
      const edge = createTestEdge({ setup: READY_SETUP, relay })
      const { batch, recorded } = batchOf([message])

      await handleQueue(batch, edge.dependencies)

      expect(recorded[0]).toMatchObject({ acked: true, retriedAfter: null })
    }
  })

  it('reads a stored body from R2 and deletes it once the controller answers', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })
    edge.objects.set(`deliveries/${DELIVERY}`, '{"large":true}')
    const { batch } = batchOf([{ ...message, body: { _tag: 'Stored', key: `deliveries/${DELIVERY}` } }])

    await handleQueue(batch, edge.dependencies)

    expect(edge.relayed[0]?.text).toBe('{"large":true}')
    expect(edge.objects.size).toBe(0)
  })

  it('keeps a stored body while the delivery waits for a retry', async () => {
    const edge = createTestEdge({ setup: READY_SETUP, relay: async () => 503 })
    edge.objects.set(`deliveries/${DELIVERY}`, '{"large":true}')
    const { batch } = batchOf([{ ...message, body: { _tag: 'Stored', key: `deliveries/${DELIVERY}` } }])

    await handleQueue(batch, edge.dependencies)

    expect(edge.objects.has(`deliveries/${DELIVERY}`)).toBe(true)
  })

  it('caps the backoff at 15 minutes', () => {
    expect(retryDelaySeconds(1)).toBe(10)
    expect(retryDelaySeconds(2)).toBe(20)
    expect(retryDelaySeconds(20)).toBe(900)
  })
})
