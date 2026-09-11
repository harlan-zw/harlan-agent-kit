import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createReconcileHint, createWebhookApp, verifyWebhookSignature, webhookHint } from '../src/index.ts'

const secret = 'a'.repeat(40)

function sign(body: string, key = secret): string {
  return `sha256=${createHmac('sha256', key).update(body).digest('hex')}`
}

function deliver(app: ReturnType<typeof createWebhookApp>, input: {
  body: string
  delivery?: string
  event?: string
  signature?: string | null
}): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json', 'x-github-delivery': input.delivery ?? 'delivery-1' })
  if (input.event !== undefined)
    headers.set('x-github-event', input.event)
  if (input.signature !== null && input.signature !== undefined)
    headers.set('x-hub-signature-256', input.signature)
  return Promise.resolve(app.fetch(new Request('http://127.0.0.1/webhook', { method: 'POST', body: input.body, headers })))
}

describe('verifying a delivery signature', () => {
  it('accepts a signature made with the secret', () => {
    expect(verifyWebhookSignature(secret, '{"a":1}', sign('{"a":1}'))).toBe(true)
  })

  it('rejects a signature made with another secret', () => {
    expect(verifyWebhookSignature(secret, '{"a":1}', sign('{"a":1}', 'b'.repeat(40)))).toBe(false)
  })

  it('rejects a signature over a different body', () => {
    expect(verifyWebhookSignature(secret, '{"a":2}', sign('{"a":1}'))).toBe(false)
  })

  it('rejects a missing signature', () => {
    expect(verifyWebhookSignature(secret, '{}', null)).toBe(false)
  })

  it('rejects a signature of the wrong length without throwing', () => {
    expect(verifyWebhookSignature(secret, '{}', 'sha256=abc')).toBe(false)
  })

  it('rejects an unprefixed digest', () => {
    expect(verifyWebhookSignature(secret, '{}', createHmac('sha256', secret).update('{}').digest('hex'))).toBe(false)
  })
})

describe('reading what one delivery asks for', () => {
  const owners = ['harlan-zw']

  it('asks to reconcile the repository the delivery names', () => {
    expect(webhookHint('pull_request', { repository: { full_name: 'harlan-zw/example' } }, owners))
      .toEqual({ _tag: 'Reconcile', repository: 'harlan-zw/example' })
  })

  it('ignores an owner outside the allowed list', () => {
    expect(webhookHint('pull_request', { repository: { full_name: 'someone-else/example' } }, owners))
      .toMatchObject({ _tag: 'Ignored' })
  })

  it('matches an owner whatever its case', () => {
    expect(webhookHint('issues', { repository: { full_name: 'Harlan-ZW/example' } }, owners))
      .toMatchObject({ _tag: 'Reconcile' })
  })

  it('ignores an event the service reads nothing from', () => {
    expect(webhookHint('star', { repository: { full_name: 'harlan-zw/example' } }, owners))
      .toMatchObject({ _tag: 'Ignored' })
  })

  it('ignores the ping GitHub sends when the hook is created', () => {
    expect(webhookHint('ping', { zen: 'Design for failure.' }, owners)).toEqual({ _tag: 'Ignored', reason: 'ping' })
  })

  it('ignores a delivery that names no repository', () => {
    expect(webhookHint('pull_request', { action: 'opened' }, owners)).toMatchObject({ _tag: 'Ignored' })
  })
})

describe('the webhook listener', () => {
  const logger = { info: () => undefined }

  function app(onHint: (repository: string) => void) {
    return createWebhookApp({ allowedOwners: ['harlan-zw'], logger, onHint, secret })
  }

  it('hints a reconciliation for a signed delivery', async () => {
    const hints: string[] = []
    const body = JSON.stringify({ repository: { full_name: 'harlan-zw/example' } })

    const response = await deliver(app(repository => hints.push(repository)), {
      body,
      event: 'pull_request',
      signature: sign(body),
    })

    expect(response.status).toBe(204)
    expect(hints).toEqual(['harlan-zw/example'])
  })

  it('refuses an unsigned delivery and hints nothing', async () => {
    const hints: string[] = []
    const body = JSON.stringify({ repository: { full_name: 'harlan-zw/example' } })

    const response = await deliver(app(repository => hints.push(repository)), {
      body,
      event: 'pull_request',
      signature: null,
    })

    expect(response.status).toBe(401)
    expect(hints).toEqual([])
  })

  it('refuses a delivery whose body was changed after signing', async () => {
    const hints: string[] = []
    const signed = JSON.stringify({ repository: { full_name: 'harlan-zw/example' } })

    const response = await deliver(app(repository => hints.push(repository)), {
      body: JSON.stringify({ repository: { full_name: 'attacker/example' } }),
      event: 'pull_request',
      signature: sign(signed),
    })

    expect(response.status).toBe(401)
    expect(hints).toEqual([])
  })

  it('answers 204 for a delivery it ignores, so GitHub does not retry it', async () => {
    const hints: string[] = []
    const body = JSON.stringify({ zen: 'Design for failure.' })

    const response = await deliver(app(repository => hints.push(repository)), {
      body,
      event: 'ping',
      signature: sign(body),
    })

    expect(response.status).toBe(204)
    expect(hints).toEqual([])
  })

  it('refuses a signed body that is not JSON', async () => {
    const response = await deliver(app(() => undefined), {
      body: 'not json',
      event: 'pull_request',
      signature: sign('not json'),
    })

    expect(response.status).toBe(400)
  })
})

describe('coalescing a burst of deliveries', () => {
  it('runs one reconciliation for many hints', async () => {
    vi.useFakeTimers()
    try {
      let runs = 0
      const coalescer = createReconcileHint({
        delayMilliseconds: 3_000,
        onError: () => undefined,
        run: async () => {
          runs += 1
        },
      })

      for (let index = 0; index < 12; index += 1)
        coalescer.hint()
      await vi.advanceTimersByTimeAsync(3_000)

      expect(runs).toBe(1)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('runs again for a hint that arrives after the pass', async () => {
    vi.useFakeTimers()
    try {
      let runs = 0
      const coalescer = createReconcileHint({
        delayMilliseconds: 1_000,
        onError: () => undefined,
        run: async () => {
          runs += 1
        },
      })

      coalescer.hint()
      await vi.advanceTimersByTimeAsync(1_000)
      coalescer.hint()
      await vi.advanceTimersByTimeAsync(1_000)

      expect(runs).toBe(2)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('runs nothing after it stops', async () => {
    vi.useFakeTimers()
    try {
      let runs = 0
      const coalescer = createReconcileHint({
        delayMilliseconds: 1_000,
        onError: () => undefined,
        run: async () => {
          runs += 1
        },
      })

      await coalescer.stop()
      coalescer.hint()
      await vi.advanceTimersByTimeAsync(5_000)

      expect(runs).toBe(0)
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('delivery recovery', () => {
  it('acknowledges a repeated delivery without requesting another read', async () => {
    const hints: string[] = []
    const app = createWebhookApp({ allowedOwners: ['harlan-zw'], logger: { info: () => undefined }, onHint: repository => hints.push(repository), secret })
    const body = JSON.stringify({ repository: { full_name: 'harlan-zw/example' } })
    const input = { body, event: 'check_run', signature: sign(body) }

    expect((await deliver(app, input)).status).toBe(204)
    expect((await deliver(app, input)).status).toBe(204)
    expect(hints).toEqual(['harlan-zw/example'])
  })

  it('accepts another delivery and permits redelivery after retention expires', async () => {
    const hints: string[] = []
    let now = 0
    const app = createWebhookApp({ allowedOwners: ['harlan-zw'], logger: { info: () => undefined }, onHint: repository => hints.push(repository), secret, now: () => now })
    const body = JSON.stringify({ repository: { full_name: 'harlan-zw/example' } })
    const input = { body, event: 'check_suite', signature: sign(body) }

    await deliver(app, input)
    await deliver(app, { ...input, delivery: 'delivery-2' })
    now = 60 * 60_000
    await deliver(app, input)
    expect(hints).toEqual(['harlan-zw/example', 'harlan-zw/example', 'harlan-zw/example'])
  })

  it('does not let a rejected signature consume a delivery', async () => {
    const hints: string[] = []
    const app = createWebhookApp({ allowedOwners: ['harlan-zw'], logger: { info: () => undefined }, onHint: repository => hints.push(repository), secret })
    const body = JSON.stringify({ repository: { full_name: 'harlan-zw/example' } })

    expect((await deliver(app, { body, event: 'status', signature: sign(body, 'wrong') })).status).toBe(401)
    expect((await deliver(app, { body, event: 'status', signature: sign(body) })).status).toBe(204)
    expect(hints).toEqual(['harlan-zw/example'])
  })

  it('rejects a signed delivery without an identity', async () => {
    const hints: string[] = []
    const app = createWebhookApp({ allowedOwners: ['harlan-zw'], logger: { info: () => undefined }, onHint: repository => hints.push(repository), secret })
    const body = JSON.stringify({ repository: { full_name: 'harlan-zw/example' } })

    expect((await deliver(app, { body, event: 'status', delivery: '', signature: sign(body) })).status).toBe(400)
    expect(hints).toEqual([])
  })

  it('coalesces all hints during an active read into one later read', async () => {
    vi.useFakeTimers()
    try {
      let finish = () => {}
      const blocked = new Promise<void>((resolve) => {
        finish = resolve
      })
      let runs = 0
      const coalescer = createReconcileHint({
        delayMilliseconds: 100,
        onError: (error) => { throw error },
        run: async () => {
          runs += 1
          if (runs === 1)
            await blocked
        },
      })
      coalescer.hint()
      await vi.advanceTimersByTimeAsync(100)
      for (let n = 0; n < 10; n += 1) {
        coalescer.hint()
        await vi.advanceTimersByTimeAsync(100)
      }
      expect(runs).toBe(1)
      finish()
      await vi.advanceTimersByTimeAsync(100)
      await coalescer.stop()
      expect(runs).toBe(2)
    }
    finally {
      vi.useRealTimers()
    }
  })
})
