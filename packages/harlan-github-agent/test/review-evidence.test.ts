import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { collectReviewEvidence } from '../src/review-evidence-cli.ts'

const execute = promisify(execFile)
it('collects exact triple-dot evidence without invoking configured diff commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-evidence-'))
  const git = async (...args: string[]) => (await execute('/usr/bin/git', ['-C', root, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', ...args])).stdout.trim()
  try {
    await git('init')
    await writeFile(join(root, 'old.ts'), 'export const old = 42')
    await writeFile(join(root, 'large.ts'), `${'x'.repeat(64_000)}before`)
    await git('add', '.')
    await git('commit', '-m', 'test: seed')
    const mergeBaseSha = await git('rev-parse', 'HEAD')
    await rm(join(root, 'old.ts'))
    await writeFile(join(root, 'large.ts'), `${'x'.repeat(64_000)}after`)
    await git('add', '.')
    await git('commit', '-m', 'test: head')
    const headSha = await git('rev-parse', 'HEAD')
    await git('checkout', '--detach', mergeBaseSha)
    await writeFile(join(root, 'unrelated.ts'), 'export const baseOnly = true')
    await git('add', '.')
    await git('commit', '-m', 'test: advance base')
    const baseSha = await git('rev-parse', 'HEAD')
    await git('config', 'diff.external', '/usr/bin/false')
    const evidence = await collectReviewEvidence(root, baseSha, headSha)
    expect(evidence._tag).toBe('Available')
    if (evidence._tag !== 'Available')
      throw new Error(evidence.reason)
    expect(evidence).toMatchObject({ baseSha, headSha, mergeBaseSha, files: { 'old.ts': { base: 'export const old = 42', head: null } } })
    expect(evidence.files['large.ts']!.head).toBe(`${'x'.repeat(64_000)}after`)
    expect(evidence.diff).toContain('deleted file mode')
    expect(evidence.diff).not.toContain('unrelated.ts')
    await expect(collectReviewEvidence(root, '--help', headSha)).rejects.toThrow('exact commit SHA')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)
