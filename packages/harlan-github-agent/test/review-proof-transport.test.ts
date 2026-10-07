import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { requestReviewProof, serveReviewProof } from '../src/review-proof-transport.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
it('forwards only a proof request over its private socket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-proof-transport-'))
  roots.push(root)
  const socket = join(root, 'proof.sock')
  const inputs: unknown[] = []
  const server = await serveReviewProof(socket, async (input) => {
    inputs.push(input)
    return { _tag: 'Refused', reason: 'already reserved' }
  })
  try {
    expect(await requestReviewProof(socket, { planId: 'node-typescript', source: 'console.log(1)' })).toEqual({ _tag: 'Refused', reason: 'already reserved' })
    expect(inputs).toEqual([{ planId: 'node-typescript', source: 'console.log(1)' }])
  }
  finally {
    await server.close()
  }
})
