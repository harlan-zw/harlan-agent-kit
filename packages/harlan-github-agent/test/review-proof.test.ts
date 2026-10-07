import type { ReviewProofAuthority, ReviewProofReceipt } from '../src/review-proof-authority.ts'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createReviewProof } from '../src/review-proof.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'review-proof-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  let reserved = false
  const receipts: ReviewProofReceipt[] = []
  const authority: ReviewProofAuthority = {
    async reserve() {
      if (reserved)
        return { _tag: 'Refused', reason: 'The central Task already reserved its proof.' }
      reserved = true
      return { _tag: 'Reserved', reservationId: 'reservation' }
    },
    async finish({ receipt }) {
      receipts.push(receipt)
    },
  }
  return { root, workspace, ledger: join(root, 'ledger'), authority, receipts }
}

it('reserves exactly one invocation across concurrent calls and controller restarts', async () => {
  const { workspace, ledger, authority, receipts } = await fixture()
  const launched: string[] = []
  const options = { workspace, ledger, authority, taskId: 'review-task', headSha: 'a'.repeat(40), now: () => new Date('2026-10-07T00:00:00Z'), launch: async (input: { sourcePath: string }) => {
    launched.push(await readFile(input.sourcePath, 'utf8'))
    return { _tag: 'Exited' as const, exitCode: 1, output: 'split bytes lost' }
  } }
  const proof = createReviewProof(options)
  const results = await Promise.all([proof.run({ planId: 'node-typescript', source: 'throw new Error("split bytes lost")' }), proof.run({ planId: 'node-typescript', source: 'console.log("weaker proof")' })])
  expect(results.filter(value => value._tag === 'Finished')).toHaveLength(1)
  expect(results.filter(value => value._tag === 'Refused')).toHaveLength(1)
  expect(launched).toHaveLength(1)
  const restarted = await createReviewProof(options).run({ planId: 'node-typescript', source: 'console.log("retry")' })
  expect(restarted._tag).toBe('Refused')
  expect(launched).toHaveLength(1)
  expect(JSON.stringify(results)).toContain('split bytes lost')
  expect(receipts).toHaveLength(1)
})

it('refuses arbitrary commands and oversized source before any invocation', async () => {
  const { workspace, ledger, authority } = await fixture()
  let launches = 0
  const proof = createReviewProof({ workspace, ledger, authority, taskId: 'review-task', headSha: 'a'.repeat(40), now: () => new Date('2026-10-07T00:00:00Z'), launch: async () => {
    launches += 1
    return { _tag: 'Exited' as const, exitCode: 0, output: '' }
  } })
  expect((await proof.run({ planId: 'bash', source: 'cat /etc/passwd' }))._tag).toBe('Refused')
  expect((await proof.run({ planId: 'node-typescript', source: 'x'.repeat(20_001) }))._tag).toBe('Refused')
  expect(launches).toBe(0)
})

it('binds the receipt to immutable source and retains signal failure', async () => {
  const { workspace, ledger, authority } = await fixture()
  const proof = createReviewProof({ workspace, ledger, authority, taskId: 'review-task', headSha: 'a'.repeat(40), now: () => new Date('2026-10-07T00:00:00Z'), launch: async ({ sourcePath }) => {
    expect(await readFile(sourcePath, 'utf8')).toBe('while (true) {}')
    return { _tag: 'Signaled' as const, signal: 'SIGKILL' as const, output: 'timed out' }
  } })
  const result = await proof.run({ planId: 'node-typescript', source: 'while (true) {}' })
  expect(result._tag).toBe('Finished')
  expect(JSON.stringify(result)).toContain('SIGKILL')
  expect(JSON.stringify(result)).toContain('a'.repeat(40))
})
