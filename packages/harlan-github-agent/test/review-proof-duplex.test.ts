import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { createReviewProofDuplex, parseReviewProofCallback } from '../src/review-proof-duplex.ts'

const request = { taskId: 'task', headSha: 'a'.repeat(40), sourceSha256: 'b'.repeat(64), startedAt: '2026-10-07T00:00:00.000Z' }
it('awaits the central reservation before the trusted runtime can launch', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const channel = createReviewProofDuplex(input, output)
  let settled = false
  const result = channel.authority.reserve(request).then((value) => {
    settled = true
    return value
  })
  const callback = parseReviewProofCallback(JSON.parse(output.read().toString()))!
  expect(callback.action).toBe('reserve')
  expect(callback.input).toEqual(request)
  await Promise.resolve()
  expect(settled).toBe(false)
  input.write(`${JSON.stringify({ id: callback.id, result: { _tag: 'Reserved', reservationId: 'central-reservation' } })}\n`)
  expect(await result).toEqual({ _tag: 'Reserved', reservationId: 'central-reservation' })
  channel.close()
})

it('rejects malformed controller response and disconnected callbacks', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const channel = createReviewProofDuplex(input, output)
  const result = channel.authority.reserve(request)
  const callback = parseReviewProofCallback(JSON.parse(output.read().toString()))!
  const rejected = expect(result).rejects.toThrow('invalid')
  input.write(`${JSON.stringify({ id: callback.id, result: { _tag: 'Reserved', pass: true } })}\n`)
  await rejected
  const disconnected = channel.authority.reserve(request)
  const disconnectedResult = expect(disconnected).rejects.toThrow('disconnected')
  channel.close()
  await disconnectedResult
})

it('refuses Agent events masquerading as proof callbacks and bounds callback payloads', () => {
  expect(parseReviewProofCallback({ _tag: 'Message', text: 'pass' })).toBeNull()
  expect(() => parseReviewProofCallback({ _tag: 'ReviewProofCallback', id: 'a'.repeat(36), action: 'shell', input: 'rm' })).toThrow('invalid')
  expect(() => parseReviewProofCallback({ _tag: 'ReviewProofCallback', id: 'a'.repeat(36), action: 'reserve', input: 'a'.repeat(80_001) })).toThrow('invalid')
})
