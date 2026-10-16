import type { AuthenticationResponseJSON } from '@simplewebauthn/server'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createEmergencyBroker, emergencyOrigin, emergencyRPID, parseEmergencyPins } from '../src/emergency-broker.ts'

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'), Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')])
  const id = Buffer.from('test-key').toString('base64url')
  const userId = Buffer.from('test-user').toString('base64url')
  const pins = { userId, credentials: [{ id, publicKey: cose.toString('base64url'), counter: 0 }] }
  let now = 1000
  const dependencies = { pins, now: () => now, check: vi.fn(), locked: () => false, persistCounter: vi.fn(), isolate: vi.fn() }
  const broker = createEmergencyBroker(dependencies)
  async function prepare() {
    const response = await broker('options', { credentialId: id })
    expect(response.status).toBe(200)
    return await response.json() as { ceremonyId: string, options: { challenge: string, userVerification: string } }
  }
  function assertion(challenge: string, overrides: { origin?: string, rp?: string, flags?: number, counter?: number, type?: string } = {}): AuthenticationResponseJSON {
    const client = Buffer.from(JSON.stringify({ type: overrides.type ?? 'webauthn.get', challenge, origin: overrides.origin ?? emergencyOrigin, crossOrigin: false }))
    const count = Buffer.alloc(4)
    count.writeUInt32BE(overrides.counter ?? 1)
    const auth = Buffer.concat([createHash('sha256').update(overrides.rp ?? emergencyRPID).digest(), Buffer.from([overrides.flags ?? 5]), count])
    const signature = sign('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]), privateKey)
    return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: client.toString('base64url'), authenticatorData: auth.toString('base64url'), signature: signature.toString('base64url'), userHandle: userId } }
  }
  return { broker, dependencies, prepare, assertion, id, pins, advance: () => {
    now += 120001
  } }
}
describe('root-owned emergency Passkey authority', () => {
  it('queues isolation only after a real signed UV assertion and a durable counter update', async () => {
    const f = fixture()
    expect((await f.broker('status')).status).toBe(200)
    expect(f.dependencies.isolate).not.toHaveBeenCalled()
    const prepared = await f.prepare()
    expect(prepared.options.userVerification).toBe('required')
    const response = await f.broker('isolate', { ceremonyId: prepared.ceremonyId, confirmation: 'ISOLATE-HOGWILD', response: f.assertion(prepared.options.challenge) })
    expect(response.status).toBe(202)
    expect(f.dependencies.persistCounter).toHaveBeenCalledWith(f.id, 1)
    expect(f.dependencies.persistCounter.mock.invocationCallOrder[0]).toBeLessThan(f.dependencies.isolate.mock.invocationCallOrder[0]!)
    expect(f.dependencies.isolate).toHaveBeenCalledTimes(1)
    expect((await f.broker('isolate', { ceremonyId: prepared.ceremonyId, confirmation: 'ISOLATE-HOGWILD', response: f.assertion(prepared.options.challenge) })).status).toBe(403)
  })
  it.each([{ origin: 'https://evil.example' }, { rp: 'evil.example' }, { flags: 1 }, { type: 'webauthn.create' }])('rejects a signed assertion with mismatched origin/RP/type or missing user verification: %j', async (overrides) => {
    const f = fixture()
    const prepared = await f.prepare()
    expect((await f.broker('isolate', { ceremonyId: prepared.ceremonyId, confirmation: 'ISOLATE-HOGWILD', response: f.assertion(prepared.options.challenge, overrides) })).status).toBe(403)
    expect(f.dependencies.isolate).not.toHaveBeenCalled()
  })
  it('rejects expired, unpinned, wrongly confirmed and challenge-substituted requests', async () => {
    const f = fixture()
    expect((await f.broker('options', { credentialId: 'foreign-key' })).status).toBe(403)
    let prepared = await f.prepare()
    expect((await f.broker('isolate', { ceremonyId: prepared.ceremonyId, response: f.assertion(prepared.options.challenge) })).status).toBe(403)
    prepared = await f.prepare()
    expect((await f.broker('isolate', { ceremonyId: prepared.ceremonyId, confirmation: 'ISOLATE-HOGWILD', response: f.assertion('wrong-challenge') })).status).toBe(403)
    prepared = await f.prepare()
    f.advance()
    expect((await f.broker('isolate', { ceremonyId: prepared.ceremonyId, confirmation: 'ISOLATE-HOGWILD', response: f.assertion(prepared.options.challenge) })).status).toBe(403)
    expect(f.dependencies.isolate).not.toHaveBeenCalled()
  })
  it('refuses isolation if counter persistence fails and never accepts recovery or power commands', async () => {
    const f = fixture()
    const prepared = await f.prepare()
    f.dependencies.persistCounter.mockImplementation(() => {
      throw new Error('read-only')
    })
    expect((await f.broker('isolate', { ceremonyId: prepared.ceremonyId, confirmation: 'ISOLATE-HOGWILD', response: f.assertion(prepared.options.challenge) })).status).toBe(503)
    for (const operation of ['recover', 'poweroff', 'reboot', 'command']) expect((await f.broker(operation)).status).toBe(404)
    expect(f.dependencies.isolate).not.toHaveBeenCalled()
  })
  it('requires a new assertion after failed verification and rejects counter rollback', async () => {
    const f = fixture()
    const prepared = await f.prepare()
    const assertion = f.assertion(prepared.options.challenge)
    assertion.response.signature = Buffer.alloc(72).toString('base64url')
    expect((await f.broker('isolate', { ceremonyId: prepared.ceremonyId, confirmation: 'ISOLATE-HOGWILD', response: assertion })).status).toBe(403)
    const second = await f.prepare()
    f.pins.credentials[0]!.counter = 10
    expect((await f.broker('isolate', { ceremonyId: second.ceremonyId, confirmation: 'ISOLATE-HOGWILD', response: f.assertion(second.options.challenge) })).status).toBe(403)
    expect(f.dependencies.isolate).not.toHaveBeenCalled()
  })
  it('bounds outstanding challenges and rejects invalid administrator key material', async () => {
    const f = fixture()
    for (let i = 0; i < 16; i++) await f.prepare()
    expect((await f.broker('options', { credentialId: f.id })).status).toBe(429)
    f.advance()
    await f.prepare()
    expect(() => parseEmergencyPins({ userId: 'user', credentials: [] })).toThrow()
    expect(() => parseEmergencyPins({ ...f.pins, credentials: [...f.pins.credentials, ...f.pins.credentials] })).toThrow()
  })
})
