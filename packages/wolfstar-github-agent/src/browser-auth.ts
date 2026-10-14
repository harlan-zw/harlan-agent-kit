import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import type { BrowserAuthStore } from './browser-auth-store.ts'
import { createHash, randomBytes } from 'node:crypto'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'

const webauthn = {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
}
const sessionDays = 30 * 24 * 60 * 60
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function cookie(headers: Headers, name: string) {
  const value = headers
    .get('cookie')
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1)
  return value && /^[\w-]{43}$/.test(value) ? value : null
}
function input(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
async function readBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader()
  if (!reader) return '{}'
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const result = await reader.read()
    if (result.done) return Buffer.concat(chunks).toString('utf8')
    length += result.value.byteLength
    if (length > 65536) {
      await reader.cancel()
      return null
    }
    chunks.push(result.value)
  }
}

/** One explicit browser authority. Machine credentials stay with their adapters. */
export function createBrowserAuth(options: {
  origin: string
  rpId: string
  store: BrowserAuthStore
  now: () => number
  webauthn?: typeof webauthn
  bootstrap: (body: Record<string, unknown>) => boolean | Promise<boolean>
  bootstrapKind: 'pairing' | 'password' | 'passkey'
  requirePasskeySession?: boolean
  surface: { _tag: 'Dashboard' } | { _tag: 'TerminalHost' }
}) {
  const origin = new URL(options.origin)
  if (
    origin.origin !== options.origin ||
    options.rpId !== origin.hostname ||
    (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && origin.hostname === 'localhost'))
  )
    throw new Error('Passkey authentication requires an exact HTTPS or localhost origin')
  const secure = origin.protocol === 'https:'
  const sessionName = secure ? '__Host-browser_auth' : 'browser_auth'
  const challengeName = secure ? '__Host-browser_ceremony' : 'browser_ceremony'
  const provider = options.webauthn ?? webauthn
  const revocations = new Set<(hash: string) => void>()
  function revokeSession(hash: string) {
    options.store.revokeSession(hash)
    for (const notify of revocations) notify(hash)
  }
  const cookieValue = (name: string, value: string, seconds: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? '; Secure' : ''}`
  function session(headers: Headers) {
    const token = cookie(headers, sessionName)
    const session = token ? options.store.sessionByHash(hash(token), options.now()) : null
    return session && (!options.requirePasskeySession || session.credentialId !== null) ? session : null
  }
  function issueSession(credentialId: string | null) {
    const token = randomBytes(32).toString('base64url')
    options.store.session({ hash: hash(token), credentialId, expires: options.now() + sessionDays * 1000 })
    return cookieValue(sessionName, token, sessionDays)
  }
  function response(value: unknown, status = 200, cookies: string[] = []) {
    const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' })
    for (const cookie of cookies) headers.append('set-cookie', cookie)
    return new Response(JSON.stringify(value), { status, headers })
  }
  const refused = (status = 401) => response({ _tag: 'Err', reason: 'AuthenticationRequired' }, status)
  return {
    origin: origin.origin,
    bootstrapKind: options.bootstrapKind,
    session,
    issueSession,
    onSessionRevocation(notify: (hash: string) => void) {
      revocations.add(notify)
      return () => revocations.delete(notify)
    },
    async handle(request: Request, trustedTransportOrigin?: string): Promise<Response | null> {
      const path = new URL(request.url).pathname
      const prefix = '/api/browser-auth/'
      if (!path.startsWith(prefix)) return null
      const transport = trustedTransportOrigin ? new URL(trustedTransportOrigin) : origin
      if (
        request.headers.get('host') !== transport.host ||
        (request.method !== 'GET' && request.headers.get('origin') !== transport.origin)
      )
        return refused(403)
      const current = session(request.headers)
      const action = path.slice(prefix.length)
      if (request.method === 'GET' && action === 'session')
        return response({
          authenticated: Boolean(current),
          bootstrapKind: options.bootstrapKind,
          surface: options.surface,
          passkeys: options.store.credentials().length > 0,
        })
      if (request.method === 'GET' && action === 'credentials')
        return current
          ? response(options.store.credentials().map(({ id, label, created }) => ({ id, label, created })))
          : refused()
      if (request.method !== 'POST') return refused(405)
      if (Number(request.headers.get('content-length') ?? 0) > 65536) return refused(413)
      const bytes = await readBody(request)
      if (bytes === null) return refused(413)
      const parsed = await Promise.resolve()
        .then(() => ({ _tag: 'Ok', value: JSON.parse(bytes || '{}') }) as const)
        .catch((cause) => ({ _tag: 'Err', reason: cause instanceof Error ? cause.message : 'Invalid JSON' }) as const)
      const body = parsed._tag === 'Ok' ? input(parsed.value) : null
      if (!body) return refused(400)
      if (action === 'bootstrap') {
        if (options.bootstrapKind === 'passkey' || !(await options.bootstrap(body))) return refused()
        return response({ authenticated: true }, 200, [issueSession(null)])
      }
      if (action === 'logout') {
        if (current) revokeSession(current.hash)
        return response({ authenticated: false }, 200, [
          cookieValue(sessionName, '', 0),
          cookieValue(challengeName, '', 0),
        ])
      }
      if (action === 'credentials/remove') {
        if (!current) return refused()
        if (typeof body.id !== 'string' || body.id.length > 2048) return refused(400)
        const hashes = options.store.sessionsForCredential(body.id)
        if (!options.store.removeCredential(body.id, options.bootstrapKind === 'passkey' ? 1 : 0)) return refused(409)
        for (const hash of hashes) {
          for (const notify of revocations) notify(hash)
        }
        return response({ removed: true })
      }
      const registration = action.startsWith('registration/')
      if (registration && !current) return refused()
      if (action === 'registration/options' || action === 'authentication/options') {
        const token = randomBytes(32).toString('base64url')
        const ceremony = registration ? 'registration' : 'authentication'
        const generated = registration
          ? await provider.generateRegistrationOptions({
              rpName: 'Wolfstar Agent Workspace',
              rpID: options.rpId,
              userName: 'wolfstar',
              userID: options.store.userId,
              attestationType: 'none',
              authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
              excludeCredentials: options.store.credentials().map((value) => ({
                id: value.id,
                ...(value.credential.transports ? { transports: value.credential.transports } : {}),
              })),
            })
          : await provider.generateAuthenticationOptions({ rpID: options.rpId, userVerification: 'required' })
        if (
          !options.store.challenge({
            hash: hash(token),
            challenge: generated.challenge,
            ceremony,
            sessionHash: registration ? current!.hash : null,
            origin: origin.origin,
            rpId: options.rpId,
            expires: options.now() + 300000,
          })
        )
          return refused(429)
        return response(generated, 200, [cookieValue(challengeName, token, 300)])
      }
      if (action !== 'registration/verify' && action !== 'authentication/verify') return refused(404)
      const token = cookie(request.headers, challengeName)
      const challenge = token
        ? options.store.consume(
            hash(token),
            registration ? 'registration' : 'authentication',
            registration ? current!.hash : null,
            options.now(),
          )
        : null
      if (!challenge || challenge.origin !== origin.origin || challenge.rpId !== options.rpId) return refused()
      const candidate = input(body.response)
      if (!candidate || typeof candidate.id !== 'string' || candidate.id.length > 2048) return refused(400)
      if (registration) {
        const verification = await provider
          .verifyRegistrationResponse({
            response: candidate as unknown as RegistrationResponseJSON,
            expectedChallenge: challenge.challenge,
            expectedOrigin: challenge.origin,
            expectedRPID: challenge.rpId,
            requireUserVerification: true,
          })
          .catch((cause: unknown) => ({
            verified: false,
            reason: cause instanceof Error ? cause.message : 'Passkey verification failed',
          }))
        if (
          !verification.verified ||
          !('registrationInfo' in verification) ||
          !verification.registrationInfo ||
          !options.store.sessionByHash(current!.hash, options.now())
        )
          return refused()
        const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : 'Passkey'
        if (
          !label ||
          !options.store.addCredential({
            id: verification.registrationInfo.credential.id,
            label,
            credential: verification.registrationInfo.credential,
            created: options.now(),
          })
        )
          return refused(409)
        return response({ registered: true }, 200, [cookieValue(challengeName, '', 0)])
      }
      const credential = options.store.credential(candidate.id)
      if (!credential || candidate.response === null || !input(candidate.response)) return refused()
      const userHandle = input(candidate.response)!.userHandle
      if (userHandle !== options.store.userId.toString('base64url')) return refused()
      const verification = await provider
        .verifyAuthenticationResponse({
          response: candidate as unknown as AuthenticationResponseJSON,
          expectedChallenge: challenge.challenge,
          expectedOrigin: challenge.origin,
          expectedRPID: challenge.rpId,
          credential: credential.credential,
          requireUserVerification: true,
        })
        .catch((cause: unknown) => ({
          verified: false,
          reason: cause instanceof Error ? cause.message : 'Passkey verification failed',
        }))
      if (
        !verification.verified ||
        !('authenticationInfo' in verification) ||
        !options.store.updateCounter(
          credential.id,
          credential.credential.counter,
          verification.authenticationInfo.newCounter,
        )
      )
        return refused()
      if (current) revokeSession(current.hash)
      return response({ authenticated: true }, 200, [issueSession(credential.id), cookieValue(challengeName, '', 0)])
    },
  }
}
export type BrowserAuth = ReturnType<typeof createBrowserAuth>
