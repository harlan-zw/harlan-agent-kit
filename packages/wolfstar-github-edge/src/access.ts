/**
 * Checks the Cloudflare Access token on each request.
 *
 * Access in front of the Worker stops a browser that has not signed in. The
 * Worker still checks the token Access attaches, so a request that reaches it
 * some other way, a route added later or a policy edited by mistake, is
 * refused here too. Only `/webhook` skips it: GitHub cannot sign in, and the
 * webhook signature authenticates it instead.
 */

export interface AccessSettings {
  /** `https://<team>.cloudflareaccess.com` */
  teamDomain: string
  /** The Application Audience (AUD) tag of the Access application. */
  audience: string
}

export interface AccessDependencies {
  fetch: typeof fetch
  now: () => number
}

interface Jwk {
  kid: string
  kty: string
  n: string
  e: string
  alg?: string
}

const JWKS_TTL_MILLISECONDS = 60 * 60 * 1000
const CLOCK_SKEW_SECONDS = 60
const keyCache = new Map<string, { keys: Map<string, CryptoKey>; expiresAt: number }>()

/** Reads both settings, or neither. One without the other is a configuration mistake. */
export function accessSettings(teamDomain: string | undefined, audience: string | undefined): AccessSettings | null {
  const domain = teamDomain?.trim() ?? ''
  const aud = audience?.trim() ?? ''
  if (domain === '' && aud === '') return null
  if (domain === '' || aud === '') throw new Error('Set both ACCESS_TEAM_DOMAIN and ACCESS_AUD, or neither.')
  const url = new URL(domain.startsWith('https://') ? domain : `https://${domain}`)
  if (!url.hostname.endsWith('.cloudflareaccess.com'))
    throw new Error('ACCESS_TEAM_DOMAIN must be https://<team>.cloudflareaccess.com.')
  return { teamDomain: url.origin, audience: aud }
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function decodeJson(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlBytes(part)))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Not a JSON object.')
  return value as Record<string, unknown>
}

async function signingKeys(
  settings: AccessSettings,
  dependencies: AccessDependencies,
): Promise<Map<string, CryptoKey>> {
  const cached = keyCache.get(settings.teamDomain)
  if (cached !== undefined && cached.expiresAt > dependencies.now()) return cached.keys

  const response = await dependencies.fetch(`${settings.teamDomain}/cdn-cgi/access/certs`)
  if (!response.ok) throw new Error(`Access certificates answered ${response.status}.`)
  const body = (await response.json()) as { keys?: Jwk[] }
  const keys = new Map<string, CryptoKey>()
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'RSA') continue
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        'jwk',
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      ),
    )
  }
  keyCache.set(settings.teamDomain, { keys, expiresAt: dependencies.now() + JWKS_TTL_MILLISECONDS })
  return keys
}

/** Forgets cached signing keys. Tests use it; Access rotates keys on its own schedule. */
export function clearAccessKeys(): void {
  keyCache.clear()
}

/** True when the request carries a valid Access token for this application. */
export async function hasAccessToken(
  request: Request,
  settings: AccessSettings,
  dependencies: AccessDependencies,
): Promise<boolean> {
  const token = request.headers.get('cf-access-jwt-assertion')
  if (token === null) return false
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]

  try {
    const header = decodeJson(headerPart)
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false

    let key = (await signingKeys(settings, dependencies)).get(header.kid)
    if (key === undefined) {
      // A key Access rotated in since the cache filled.
      keyCache.delete(settings.teamDomain)
      key = (await signingKeys(settings, dependencies)).get(header.kid)
    }
    if (key === undefined) return false

    const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`)
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlBytes(signaturePart), signed))) return false

    const payload = decodeJson(payloadPart)
    const now = Math.floor(dependencies.now() / 1000)
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    return (
      payload.iss === settings.teamDomain &&
      audiences.includes(settings.audience) &&
      typeof payload.exp === 'number' &&
      payload.exp + CLOCK_SKEW_SECONDS > now &&
      (typeof payload.nbf !== 'number' || payload.nbf - CLOCK_SKEW_SECONDS <= now)
    )
  } catch {
    return false
  }
}
