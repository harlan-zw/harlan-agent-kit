import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createWebhookApp, createWebhookControls } from '../src/index.ts'
import { openJournalStore } from '../src/store.ts'
import { COMMENT_DELIVERY_PROOF_DAYS } from '../src/webhook-controls.ts'

describe('repository checkbox coverage', () => {
  it('does not offer a checkbox on any repository without comment deliveries', () => {
    const controls = createWebhookControls({ ready: () => true })
    expect(controls.available('nuxt/scripts')).toBe(false)
    expect(controls.available('harlan-zw/example')).toBe(false)
  })

  it('requires the running listener even after a verified delivery', () => {
    const controls = createWebhookControls({ ready: () => false })
    controls.observe('harlan-zw/example', 'issue_comment')
    expect(controls.available('harlan-zw/example')).toBe(false)
  })

  it('requires a comment event, not a check or push delivery', () => {
    const controls = createWebhookControls({ ready: () => true })
    controls.observe('nuxt/scripts', 'check_run')
    expect(controls.available('nuxt/scripts')).toBe(false)
    controls.observe('nuxt/scripts', 'issue_comment')
    expect(controls.available('NUXT/SCRIPTS')).toBe(true)
    expect(controls.available('nuxt/nuxt')).toBe(false)
  })

  it.each([true, false])('enables controls only after a verified comment delivery: signed=%s', async (signed) => {
    const secret = 'test-webhook-secret'
    const controls = createWebhookControls({ ready: () => true })
    const app = createWebhookApp({
      secret,
      allowedOwners: ['nuxt'],
      logger: { info: () => undefined },
      onHint: controls.observe,
    })
    const body = JSON.stringify({ repository: { full_name: 'nuxt/scripts' } })
    const response = await app.fetch(new Request('http://localhost/webhook', {
      method: 'POST',
      body,
      headers: {
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'comment-delivery',
        'x-hub-signature-256': `sha256=${createHmac('sha256', signed ? secret : 'wrong-secret').update(body).digest('hex')}`,
      },
    }))
    expect(response.status).toBe(signed ? 204 : 401)
    expect(controls.available('nuxt/scripts')).toBe(signed)
  })
})

describe('repository checkbox coverage across a restart', () => {
  const secret = 'test-webhook-secret'
  const day = 24 * 60 * 60_000

  async function deliverComment(store: ReturnType<typeof openJournalStore>, at: number) {
    const app = createWebhookApp({ secret, allowedOwners: ['harlan-zw'], logger: { info: () => undefined }, onHint: () => undefined, now: () => at, recordDelivery: delivery => store.recordDelivery(delivery) })
    const body = JSON.stringify({ action: 'edited', repository: { full_name: 'harlan-zw/example' } })
    const response = await app.fetch(new Request('http://localhost/webhook', {
      method: 'POST',
      body,
      headers: {
        'x-github-event': 'issue_comment',
        'x-github-delivery': `comment-${at}`,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
    }))
    expect(response.status).toBe(204)
  }

  it.each([
    { age: 'an hour', milliseconds: 60 * 60_000, covered: true },
    { age: 'eight days', milliseconds: 8 * day, covered: false },
  ])('counts a comment delivery from $age before a restart: $covered', async ({ milliseconds, covered }) => {
    const store = openJournalStore(':memory:', true)
    const restartedAt = Date.parse('2026-11-24T08:13:00.000Z')
    await deliverComment(store, restartedAt - milliseconds)

    const controls = createWebhookControls({ ready: () => true, covered: store.recentDeliveryRepositories('issue_comment', restartedAt - COMMENT_DELIVERY_PROOF_DAYS * day) })
    expect(controls.available('harlan-zw/example')).toBe(covered)
    store.close()
  })
})
