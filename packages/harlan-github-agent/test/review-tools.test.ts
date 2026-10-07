import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createReviewTools } from '../src/review-tools.ts'

it('serves static reads and one fixed proof plan without arbitrary execution tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-tools-'))
  try {
    await writeFile(join(root, 'source.ts'), 'export const answer = 42')
    const inputs: unknown[] = []
    const tools = createReviewTools({ workspace: root, proof: async (input) => {
      inputs.push(input)
      return { _tag: 'Refused', reason: 'already reserved' }
    } })
    expect(await tools.call('review_read', { path: 'source.ts' })).toEqual({ _tag: 'Read', text: 'export const answer = 42', truncated: false })
    expect(await tools.call('review_proof', { planId: 'node-typescript', source: 'console.log(42)' })).toEqual({ _tag: 'Refused', reason: 'already reserved' })
    expect(inputs).toEqual([{ planId: 'node-typescript', source: 'console.log(42)' }])
    for (const name of ['bash', 'exec', 'write', 'apply_patch', 'delegate'])
      expect(await tools.call(name, {})).toEqual({ _tag: 'Refused', reason: 'This Review tool is unavailable.' })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
