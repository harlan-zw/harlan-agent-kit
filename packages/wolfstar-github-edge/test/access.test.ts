import { beforeEach, describe, expect, it } from 'vitest'
import { accessSettings, clearAccessKeys } from '../src/access.ts'
import { handleRequest } from '../src/app.ts'
import { ORIGIN, READY_SETUP, createTestEdge, sign } from './fixtures.ts'

const TEAM = 'https://wolfstar.cloudflareaccess.com'
const AUD = 'access-application-audience-tag'
const NOW = Date.parse('2026-10-14T12:00:00.000Z')

function base64Url(bytes: Uint8Array | string): string {
  const binary = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const keys = (await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair
const otherKeys = (await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair
const publicJwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey

async function token(
  claims: Record<string, unknown> = {},
  signingKey = keys.privateKey,
  kid = 'key-1',
): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))
  const payload = base64Url(
    JSON.stringify({
      iss: TEAM,
      aud: [AUD],
      exp: NOW / 1000 + 600,
      nbf: NOW / 1000 - 10,
      email: 'me@example.com',
      ...claims,
    }),
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, new TextEncoder().encode(`${header}.${payload}`)),
  )
  return `${header}.${payload}.${base64Url(signature)}`
}

function protectedEdge() {
  const edge = createTestEdge({
    setup: READY_SETUP,
    now: NOW,
    github: async (url) =>
      url === `${TEAM}/cdn-cgi/access/certs`
        ? Response.json({ keys: [{ ...publicJwk, kid: 'key-1' }] })
        : new Response(null, { status: 404 }),
  })
  edge.dependencies.access = { teamDomain: TEAM, audience: AUD }
  return edge
}

beforeEach(() => clearAccessKeys())

describe('Cloudflare Access check', () => {
  it('lets a request with a valid Access token reach the dashboard', async () => {
    const edge = protectedEdge()

    const response = await handleRequest(
      new Request(`${ORIGIN}/history`, { headers: { 'cf-access-jwt-assertion': await token() } }),
      edge.dependencies,
    )

    expect(await response.text()).toBe('dashboard')
  })

  it('refuses a request without a token, before setup or the dashboard sees it', async () => {
    const edge = protectedEdge()

    for (const path of ['/', '/history', '/setup', '/setup/providers', '/webhook/']) {
      const response = await handleRequest(new Request(`${ORIGIN}${path}`), edge.dependencies)
      expect(response.status).toBe(403)
    }
    expect(edge.dashboard).toHaveLength(0)
  })

  it('refuses a token for another application, another team, a wrong key, or past its expiry', async () => {
    const edge = protectedEdge()

    for (const bad of [
      await token({ aud: ['another-application'] }),
      await token({ iss: 'https://someone.cloudflareaccess.com' }),
      await token({ exp: NOW / 1000 - 120 }),
      await token({ nbf: NOW / 1000 + 600 }),
      await token({}, otherKeys.privateKey),
      await token({}, keys.privateKey, 'unknown-key'),
      'not.a.token',
      'garbage',
    ]) {
      const response = await handleRequest(
        new Request(`${ORIGIN}/history`, { headers: { 'cf-access-jwt-assertion': bad } }),
        edge.dependencies,
      )
      expect(response.status).toBe(403)
    }
    expect(edge.dashboard).toHaveLength(0)
  })

  it('keeps the webhook open to GitHub, which authenticates by signature instead', async () => {
    const edge = protectedEdge()

    const response = await handleRequest(
      new Request(`${ORIGIN}/webhook`, {
        method: 'POST',
        headers: {
          'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958',
          'x-github-event': 'issues',
          'x-hub-signature-256': await sign('{}'),
        },
        body: '{}',
      }),
      edge.dependencies,
    )

    expect(response.status).toBe(204)
    expect(edge.sent).toHaveLength(1)
  })
})

describe('Access settings', () => {
  it('is off when neither variable is set', () => {
    expect(accessSettings(undefined, undefined)).toBeNull()
    expect(accessSettings('', ' ')).toBeNull()
  })

  it('normalises the team domain', () => {
    expect(accessSettings('wolfstar.cloudflareaccess.com', AUD)).toEqual({ teamDomain: TEAM, audience: AUD })
    expect(accessSettings(`${TEAM}/`, AUD)).toEqual({ teamDomain: TEAM, audience: AUD })
  })

  it('fails closed on half a configuration or a foreign domain', () => {
    expect(() => accessSettings(TEAM, undefined)).toThrow('Set both')
    expect(() => accessSettings(undefined, AUD)).toThrow('Set both')
    expect(() => accessSettings('https://evil.example', AUD)).toThrow('cloudflareaccess.com')
  })
})
