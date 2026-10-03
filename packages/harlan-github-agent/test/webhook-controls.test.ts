import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createWebhookApp, createWebhookControls } from '../src/index.ts'

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
