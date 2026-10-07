import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createReviewTools } from '../src/review-tools.ts'

it('pages late workspace code and immutable deleted base evidence without spending a proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-tools-evidence-'))
  try {
    await writeFile(join(root, 'large.ts'), `${'x'.repeat(64_000)}late code`)
    const artifact = join(root, 'evidence.json')
    await writeFile(artifact, JSON.stringify({ _tag: 'Available', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), mergeBaseSha: 'a'.repeat(40), diff: 'deleted old.ts', files: { 'old.ts': { base: 'deleted exported API', head: null } } }))
    let attempts = 0
    const tools = createReviewTools({ workspace: root, evidencePath: artifact, proof: async () => {
      attempts++
      return null
    } })
    expect(await tools.call('review_read', { path: 'large.ts', offset: 64_000 })).toMatchObject({ _tag: 'Read', text: 'late code', truncated: false })
    expect(await tools.call('review_read', { revision: 'diff', path: '' })).toMatchObject({ _tag: 'Read', text: 'deleted old.ts' })
    expect(await tools.call('review_read', { revision: 'base', path: 'old.ts' })).toMatchObject({ _tag: 'Read', text: 'deleted exported API' })
    expect(await tools.call('review_read', { revision: 'head', path: 'old.ts' })).toMatchObject({ _tag: 'Refused' })
    expect(await tools.call('review_read', { revision: 'base', path: '../secret' })).toMatchObject({ _tag: 'Refused' })
    expect(await tools.call('review_read', { path: 'large.ts', offset: -1 })).toMatchObject({ _tag: 'Refused' })
    await writeFile(join(root, 'unicode.ts'), `${'x'.repeat(15_999)}☃end`)
    const first = await tools.call('review_read', { path: 'unicode.ts' }) as { text: string, nextOffset: number }
    const second = await tools.call('review_read', { path: 'unicode.ts', offset: first.nextOffset }) as { text: string }
    expect(first.text + second.text).toBe(`${'x'.repeat(15_999)}☃end`)
    expect(attempts).toBe(0)
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

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
