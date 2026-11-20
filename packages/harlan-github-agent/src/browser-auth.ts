import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import type { BrowserAuthStore, BrowserEnrolment, BrowserSession } from './browser-auth-store.ts'
import { createHash, randomBytes } from 'node:crypto'
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'

const webauthn = { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse }
export type BrowserWebAuthn = typeof webauthn
const sessionDays = 30 * 24 * 60 * 60
const enrolmentSeconds = 15 * 60
export const hashBrowserToken = (value: string) => createHash('sha256').update(value).digest('hex')
const hash = hashBrowserToken
function cookie(headers: Headers, name: string) {
  const value = headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)
  return value && /^[\w-]{43}$/.test(value) ? value : null
}
function input(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
async function readBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader()
  if (!reader)
    return '{}'
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const result = await reader.read()
    if (result.done)
      return Buffer.concat(chunks).toString('utf8')
    length += result.value.byteLength
    if (length > 65536) {
      await reader.cancel()
      return null
    }
    chunks.push(result.value)
  }
}

/** Who may run a registration ceremony. An enrolment can add a Passkey and nothing else. */
type Registrant = { _tag: 'Session', session: BrowserSession } | { _tag: 'Enrolment', enrolment: BrowserEnrolment }

/**
 * One explicit browser authority. Machine credentials stay with their adapters.
 *
 * `bootstrapKind` decides what a redeemed pairing secret grants:
 * - `passkey`: a short enrolment that can add one Passkey. Only a Passkey signs in.
 * - `pairing`: a full session. Only the standalone loopback terminal uses it.
 */
export function createBrowserAuth(options: {
  origin: string
  rpId: string
  store: BrowserAuthStore
  now: () => number
  webauthn?: BrowserWebAuthn
  bootstrap: (body: Record<string, unknown>) => boolean | Promise<boolean>
  bootstrapKind: 'pairing' | 'passkey'
  surface: { _tag: 'Dashboard' } | { _tag: 'TerminalHost' }
}) {
  const origin = new URL(options.origin)
  if (origin.origin !== options.origin || options.rpId !== origin.hostname || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && origin.hostname === 'localhost')))
    throw new Error('Passkey authentication requires an exact HTTPS or localhost origin')
  const secure = origin.protocol === 'https:'
  const passkeyOnly = options.bootstrapKind === 'passkey'
  const sessionName = secure ? '__Host-browser_auth' : 'browser_auth'
  const enrolmentName = secure ? '__Host-browser_enrolment' : 'browser_enrolment'
  const challengeName = secure ? '__Host-browser_ceremony' : 'browser_ceremony'
  const provider = options.webauthn ?? webauthn
  const revocations = new Set<(hash: string) => void>()
  function revokeSession(hash: string) {
    options.store.revokeSession(hash)
    for (const notify of revocations) notify(hash)
  }
  const cookieValue = (name: string, value: string, seconds: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? '; Secure' : ''}`
  /** A signed-in session. A Passkey-only authority accepts only sessions bound to a Passkey. */
  function session(headers: Headers) {
    const token = cookie(headers, sessionName)
    const session = token ? options.store.sessionByHash(hash(token), options.now()) : null
    return session && (!passkeyOnly || session.credentialId !== null) ? session : null
  }
  function enrolment(headers: Headers) {
    const token = passkeyOnly ? cookie(headers, enrolmentName) : null
    return token ? options.store.enrolmentByHash(hash(token), options.now()) : null
  }
  function issueSession(credentialId: string | null) {
    const token = randomBytes(32).toString('base64url')
    options.store.session({ hash: hash(token), credentialId, expires: options.now() + sessionDays * 1000 })
    return cookieValue(sessionName, token, sessionDays)
  }
  function issueEnrolment() {
    const token = randomBytes(32).toString('base64url')
    options.store.enrolment({ hash: hash(token), expires: options.now() + enrolmentSeconds * 1000 }, options.now())
    return cookieValue(enrolmentName, token, enrolmentSeconds)
  }
  // Challenges bind to their owner. The prefix keeps an enrolment and a session apart.
  const owner = (registrant: Registrant) => registrant._tag === 'Session' ? registrant.session.hash : `enrolment:${registrant.enrolment.hash}`
  function stillValid(registrant: Registrant) {
    return registrant._tag === 'Session'
      ? options.store.sessionByHash(registrant.session.hash, options.now()) !== null
      : options.store.enrolmentByHash(registrant.enrolment.hash, options.now()) !== null
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
    enrolment,
    issueSession,
    hasPasskeys: () => options.store.credentials().length > 0,
    onSessionRevocation(notify: (hash: string) => void) {
      revocations.add(notify)
      return () => revocations.delete(notify)
    },
    async handle(request: Request, trustedTransportOrigin?: string): Promise<Response | null> {
      const path = new URL(request.url).pathname
      const prefix = '/api/browser-auth/'
      if (!path.startsWith(prefix))
        return null
      const transport = trustedTransportOrigin ? new URL(trustedTransportOrigin) : origin
      if (request.headers.get('host') !== transport.host || (request.method !== 'GET' && request.headers.get('origin') !== transport.origin))
        return refused(403)
      const current = session(request.headers)
      const enrolling = current ? null : enrolment(request.headers)
      // An enrolment is known but may not do this. A browser with neither must sign in.
      const signedOut = () => refused(enrolling ? 403 : 401)
      const action = path.slice(prefix.length)
      if (request.method === 'GET' && action === 'session')
        return response({ authenticated: Boolean(current), enrolment: Boolean(enrolling), bootstrapKind: options.bootstrapKind, surface: options.surface, passkeys: options.store.credentials().length > 0 })
      if (request.method === 'GET' && action === 'credentials')
        return current ? response(options.store.credentials().map(({ id, label, created }) => ({ id, label, created }))) : signedOut()
      if (request.method !== 'POST')
        return refused(405)
      if (Number(request.headers.get('content-length') ?? 0) > 65536)
        return refused(413)
      const bytes = await readBody(request)
      if (bytes === null)
        return refused(413)
      const parsed = await Promise.resolve().then(() => ({ _tag: 'Ok', value: JSON.parse(bytes || '{}') } as const)).catch(cause => ({ _tag: 'Err', reason: cause instanceof Error ? cause.message : 'Invalid JSON' } as const))
      const body = parsed._tag === 'Ok' ? input(parsed.value) : null
      if (!body)
        return refused(400)
      if (action === 'bootstrap') {
        if (!await options.bootstrap(body))
          return refused()
        return passkeyOnly
          ? response({ authenticated: false, enrolment: true }, 200, [issueEnrolment()])
          : response({ authenticated: true }, 200, [issueSession(null)])
      }
      if (action === 'logout') {
        if (current)
          revokeSession(current.hash)
        if (enrolling)
          options.store.revokeEnrolment(enrolling.hash)
        return response({ authenticated: false }, 200, [cookieValue(sessionName, '', 0), cookieValue(enrolmentName, '', 0), cookieValue(challengeName, '', 0)])
      }
      if (action === 'credentials/remove') {
        if (!current)
          return signedOut()
        if (typeof body.id !== 'string' || body.id.length > 2048)
          return refused(400)
        const hashes = options.store.sessionsForCredential(body.id)
        if (!options.store.removeCredential(body.id, passkeyOnly ? 1 : 0))
          return refused(409)
        for (const hash of hashes) {
          for (const notify of revocations) notify(hash)
        }
        return response({ removed: true })
      }
      const registration = action.startsWith('registration/')
      const registrant: Registrant | null = current ? { _tag: 'Session', session: current } : enrolling ? { _tag: 'Enrolment', enrolment: enrolling } : null
      if (registration && !registrant)
        return refused()
      if (action === 'registration/options' || action === 'authentication/options') {
        const token = randomBytes(32).toString('base64url')
        const ceremony = registration ? 'registration' : 'authentication'
        // Discoverable credentials with user verification let sign-in work without a username.
        const generated = registration
          ? await provider.generateRegistrationOptions({ rpName: 'Harlan Agent Workspace', rpID: options.rpId, userName: 'harlan', userID: options.store.userId, attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: options.store.credentials().map(value => ({ id: value.id, ...(value.credential.transports ? { transports: value.credential.transports } : {}) })) })
          : await provider.generateAuthenticationOptions({ rpID: options.rpId, userVerification: 'required' })
        if (!options.store.challenge({ hash: hash(token), challenge: generated.challenge, ceremony, sessionHash: registration ? owner(registrant!) : null, origin: origin.origin, rpId: options.rpId, expires: options.now() + 300000 }))
          return refused(429)
        return response(generated, 200, [cookieValue(challengeName, token, 300)])
      }
      if (action !== 'registration/verify' && action !== 'authentication/verify')
        return refused(404)
      const token = cookie(request.headers, challengeName)
      const challenge = token ? options.store.consume(hash(token), registration ? 'registration' : 'authentication', registration ? owner(registrant!) : null, options.now()) : null
      if (!challenge || challenge.origin !== origin.origin || challenge.rpId !== options.rpId)
        return refused()
      const candidate = input(body.response)
      if (!candidate || typeof candidate.id !== 'string' || candidate.id.length > 2048)
        return refused(400)
      if (registration) {
        const verification = await provider.verifyRegistrationResponse({ response: candidate as unknown as RegistrationResponseJSON, expectedChallenge: challenge.challenge, expectedOrigin: challenge.origin, expectedRPID: challenge.rpId, requireUserVerification: true }).catch((cause: unknown) => ({ verified: false, reason: cause instanceof Error ? cause.message : 'Passkey verification failed' }))
        if (!verification.verified || !('registrationInfo' in verification) || !verification.registrationInfo || !stillValid(registrant!))
          return refused()
        const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : 'Passkey'
        const credential = verification.registrationInfo.credential
        if (!label || !options.store.addCredential({ id: credential.id, label, credential, created: options.now() }))
          return refused(409)
        if (registrant!._tag === 'Session')
          return response({ registered: true }, 200, [cookieValue(challengeName, '', 0)])
        // The enrolment is spent. The new Passkey signs this browser in.
        options.store.revokeEnrolment(registrant!.enrolment.hash)
        return response({ registered: true }, 200, [issueSession(credential.id), cookieValue(enrolmentName, '', 0), cookieValue(challengeName, '', 0)])
      }
      const credential = options.store.credential(candidate.id)
      if (!credential || candidate.response === null || !input(candidate.response))
        return refused()
      const userHandle = input(candidate.response)!.userHandle
      if (userHandle !== options.store.userId.toString('base64url'))
        return refused()
      const verification = await provider.verifyAuthenticationResponse({ response: candidate as unknown as AuthenticationResponseJSON, expectedChallenge: challenge.challenge, expectedOrigin: challenge.origin, expectedRPID: challenge.rpId, credential: credential.credential, requireUserVerification: true }).catch((cause: unknown) => ({ verified: false, reason: cause instanceof Error ? cause.message : 'Passkey verification failed' }))
      if (!verification.verified || !('authenticationInfo' in verification) || !options.store.updateCounter(credential.id, credential.credential.counter, verification.authenticationInfo.newCounter))
        return refused()
      if (current)
        revokeSession(current.hash)
      if (enrolling)
        options.store.revokeEnrolment(enrolling.hash)
      return response({ authenticated: true }, 200, [issueSession(credential.id), cookieValue(enrolmentName, '', 0), cookieValue(challengeName, '', 0)])
    },
  }
}
export type BrowserAuth = ReturnType<typeof createBrowserAuth>
