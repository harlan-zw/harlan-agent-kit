import type { AuthenticationResponseJSON, WebAuthnCredential } from '@simplewebauthn/server'
import { randomUUID } from 'node:crypto'
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server'

export const emergencyOrigin = 'https://agent.harlanzw.com'
export const emergencyRPID = 'agent.harlanzw.com'
export interface EmergencyPasskey {
  id: string
  publicKey: string
  counter: number
}
export interface EmergencyPins { userId: string, credentials: EmergencyPasskey[] }

/** Only public verification material is provisioned by an administrator. */
export function parseEmergencyPins(value: unknown): EmergencyPins {
  const pins = value as EmergencyPins | null
  const encoded = (s: unknown) => typeof s === 'string' && /^[\w-]{1,4096}$/.test(s)
  if (!pins || !encoded(pins.userId) || !Array.isArray(pins.credentials) || pins.credentials.length < 1 || pins.credentials.length > 20
    || pins.credentials.some(key => !key || !encoded(key.id) || !encoded(key.publicKey) || !Number.isSafeInteger(key.counter) || key.counter < 0)
    || new Set(pins.credentials.map(key => key.id)).size !== pins.credentials.length) {
    throw new Error('Invalid administrator-provisioned emergency Passkeys.')
  }
  return pins
}

export function createEmergencyBroker(options: {
  pins: EmergencyPins
  now: () => number
  check: () => void
  locked: () => boolean
  persistCounter: (id: string, counter: number) => void
  isolate: () => void
  poweroff?: () => void
}) {
  const challenges = new Map<string, { challenge: string, credentialId: string, expires: number, action: 'isolate' | 'poweroff' }>()
  let verifying = false
  let requested = false
  const reply = (status: number, value: unknown) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
  return async (operation: string, body: unknown = {}): Promise<Response> => {
    try {
      if (operation === 'status') {
        options.check()
        return reply(200, { available: true, locked: options.locked() || requested, poweroffAvailable: !!options.poweroff })
      }
      const input = body as Record<string, unknown> | null
      if (!input || typeof input !== 'object' || Array.isArray(input))
        return reply(400, { error: 'Invalid request.' })
      if (operation === 'options' || operation === 'poweroff-options') {
        const action = operation === 'poweroff-options' ? 'poweroff' : 'isolate'
        if (action === 'poweroff' && !options.poweroff)
          return reply(503, { error: 'Power off is unavailable.' })
        const credential = options.pins.credentials.find(key => key.id === input.credentialId)
        if (!credential)
          return reply(403, { error: 'This Passkey is not approved for emergency isolation.' })
        for (const [id, challenge] of challenges) {
          if (challenge.expires <= options.now())
            challenges.delete(id)
        }
        if (challenges.size >= 16)
          return reply(429, { error: 'Too many Passkey requests. Wait two minutes.' })
        options.check()
        if (options.locked() || requested)
          return reply(409, { error: 'A host action has already been requested.' })
        const authentication = await generateAuthenticationOptions({ rpID: emergencyRPID, allowCredentials: [{ id: credential.id }], userVerification: 'required', timeout: 120_000 })
        const ceremonyId = randomUUID()
        challenges.set(ceremonyId, { challenge: authentication.challenge, credentialId: credential.id, expires: options.now() + 120_000, action })
        return reply(200, { ceremonyId, options: authentication })
      }
      if (operation !== 'isolate' && operation !== 'poweroff')
        return reply(404, { error: 'Unknown operation.' })
      const ceremony = typeof input.ceremonyId === 'string' ? challenges.get(input.ceremonyId) : undefined
      // Consume before verification; failed and concurrent requests cannot replay it.
      if (typeof input.ceremonyId === 'string')
        challenges.delete(input.ceremonyId)
      const confirmation = operation === 'poweroff' ? 'POWER-OFF-HOGWILD' : 'ISOLATE-HOGWILD'
      if (!ceremony || ceremony.action !== operation || ceremony.expires <= options.now() || input.confirmation !== confirmation)
        return reply(403, { error: 'Fresh confirmation for this action is required.' })
      if (verifying || requested || options.locked())
        return reply(409, { error: 'A host action is already running.' })
      const assertion = input.response as AuthenticationResponseJSON | undefined
      const pinned = options.pins.credentials.find(key => key.id === ceremony.credentialId)
      if (!pinned || assertion?.id !== pinned.id || assertion.response?.userHandle !== options.pins.userId)
        return reply(403, { error: 'Passkey does not match.' })
      verifying = true
      try {
        const credential: WebAuthnCredential = { id: pinned.id, publicKey: new Uint8Array(Buffer.from(pinned.publicKey, 'base64url')), counter: pinned.counter }
        const result = await verifyAuthenticationResponse({ response: assertion, credential, expectedChallenge: ceremony.challenge, expectedOrigin: emergencyOrigin, expectedRPID: emergencyRPID, requireUserVerification: true }).catch(() => {
          // Malformed or invalid assertions become the same refusal below; no action runs.
          return null
        })
        if (!result?.verified)
          return reply(403, { error: 'Passkey verification failed.' })
        // Durable monotonic counter precedes the action, including for non-synced keys.
        options.persistCounter(pinned.id, result.authenticationInfo.newCounter)
        pinned.counter = result.authenticationInfo.newCounter
        const action = operation === 'poweroff' ? options.poweroff : options.isolate
        if (!action)
          return reply(503, { error: 'This host action is unavailable.' })
        // An indeterminate command failure must not authorize another host action.
        requested = true
        action()
        return reply(202, { accepted: true })
      }
      finally { verifying = false }
    }
    catch {
      // Do not leak root command output, paths or credential material to the browser.
      return reply(503, { error: 'Could not confirm the host action. Inspect through admin recovery.' })
    }
  }
}
