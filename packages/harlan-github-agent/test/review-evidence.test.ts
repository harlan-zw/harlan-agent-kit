import { execFile } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { collectReviewEvidence } from '../src/review-evidence-cli.ts'
import { createReviewTools } from '../src/review-tools.ts'

const execute = promisify(execFile)
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])

async function revisionFixture(before: Record<string, string | Buffer>, after: Record<string, string | Buffer>, run: (fixture: { root: string, baseSha: string, headSha: string, git: (...args: string[]) => Promise<string> }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'review-revisions-'))
  const git = async (...args: string[]) => (await execute('/usr/bin/git', ['-C', root, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', ...args])).stdout.trim()
  try {
    await git('init')
    for (const [path, content] of Object.entries(before))
      await writeFile(join(root, path), content)
    await git('add', ...Object.keys(before))
    await git('commit', '-m', 'test: seed revisions')
    const baseSha = await git('rev-parse', 'HEAD')
    for (const path of Object.keys(before))
      await rm(join(root, path))
    for (const [path, content] of Object.entries(after))
      await writeFile(join(root, path), content)
    await git('add', '--', ...new Set([...Object.keys(before), ...Object.keys(after)]))
    await git('commit', '-m', 'test: change revisions')
    await run({ root, baseSha, headSha: await git('rev-parse', 'HEAD'), git })
  }
  finally { await rm(root, { recursive: true, force: true }) }
}

async function toolsForEvidence(root: string, baseSha: string, headSha: string) {
  const artifact = join(root, 'evidence.json')
  await writeFile(artifact, JSON.stringify(await collectReviewEvidence(root, baseSha, headSha)))
  return createReviewTools({ workspace: root, evidencePath: artifact, proof: async () => {
    throw new Error('No proof requested.')
  } })
}

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
    expect(evidence).toMatchObject({ baseSha, headSha, mergeBaseSha, files: { 'old.ts': { base: { _tag: 'Text', text: 'export const old = 42' }, head: { _tag: 'Missing' } } } })
    expect(evidence.files['large.ts']!.head).toMatchObject({ _tag: 'Text', text: `${'x'.repeat(64_000)}after` })
    expect(evidence.diff).toContain('deleted file mode')
    expect(evidence.diff).not.toContain('unrelated.ts')
    await expect(collectReviewEvidence(root, '--help', headSha)).rejects.toThrow('exact commit SHA')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)

it('keeps exact source reads and patches available beside committed screenshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-binary-evidence-'))
  const git = async (...args: string[]) => (await execute('/usr/bin/git', ['-C', root, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', ...args])).stdout.trim()
  try {
    await git('init')
    await writeFile(join(root, 'source.ts'), 'export const version = 1\n')
    await git('add', 'source.ts')
    await git('commit', '-m', 'test: seed source')
    const baseSha = await git('rev-parse', 'HEAD')
    await writeFile(join(root, 'source.ts'), 'export const version = 2\n')
    await writeFile(join(root, 'screenshot.png'), png)
    await git('add', 'source.ts', 'screenshot.png')
    await git('commit', '-m', 'test: add screenshot and change source')
    const headSha = await git('rev-parse', 'HEAD')
    const imageOid = await git('rev-parse', `${headSha}:screenshot.png`)
    const evidence = await collectReviewEvidence(root, baseSha, headSha)
    const artifact = join(root, 'evidence.json')
    await writeFile(artifact, JSON.stringify(evidence))
    const tools = createReviewTools({ workspace: root, evidencePath: artifact, proof: async () => {
      throw new Error('No proof requested.')
    } })
    await expect(tools.call('review_read', { revision: 'base', path: 'source.ts' })).resolves.toMatchObject({ _tag: 'Read', text: 'export const version = 1\n' })
    await expect(tools.call('review_read', { revision: 'head', path: 'source.ts' })).resolves.toMatchObject({ _tag: 'Read', text: 'export const version = 2\n' })
    await expect(tools.call('review_read', { revision: 'diff', path: '' })).resolves.toMatchObject({ _tag: 'Read', text: expect.stringContaining('+export const version = 2') })
    await expect(tools.call('review_read', { revision: 'head', path: 'screenshot.png' })).resolves.toMatchObject({ _tag: 'Unavailable', content: { _tag: 'Binary', oid: imageOid, bytes: 9 } })
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

it('preserves large binary revisions and text transitions without executing diff drivers', async () => {
  const largePng = Buffer.concat([png, Buffer.alloc(1_050_000)])
  const attributes = '* diff=hostile\n'
  await revisionFixture(
    { '.gitattributes': attributes, 'source.ts': 'before\n', 'removed.png': png, 'becomes-binary.ts': 'old text\n', 'becomes-text.png': png, 'changed.png': png },
    { '.gitattributes': attributes, 'source.ts': 'after\n', 'added.data': largePng, 'becomes-binary.ts': png, 'becomes-text.png': 'new text\n', 'changed.png': Buffer.concat([png, Buffer.from('new')]) },
    async ({ root, baseSha, headSha, git }) => {
      await git('config', 'diff.external', '/usr/bin/false')
      await git('config', 'diff.hostile.command', '/usr/bin/false')
      await git('config', 'diff.hostile.textconv', '/usr/bin/false')
      await git('config', 'diff.hostile.binary', 'false')
      const tools = await toolsForEvidence(root, baseSha, headSha)
      const diff = await tools.call('review_read', { revision: 'diff', path: '' }) as { _tag: string, text: string }
      expect(diff._tag).toBe('Read')
      expect(diff.text).toContain('+after')
      expect(diff.text).toContain('added.data')
      expect(diff.text).toContain('removed.png')
      expect(diff.text).not.toContain('GIT binary patch')
      await expect(tools.call('review_read', { revision: 'head', path: 'source.ts' })).resolves.toMatchObject({ _tag: 'Read', text: 'after\n' })
      for (const [path, revision, sha, size] of [
        ['added.data', 'head', headSha, largePng.length],
        ['removed.png', 'base', baseSha, png.length],
        ['becomes-binary.ts', 'head', headSha, png.length],
        ['becomes-text.png', 'base', baseSha, png.length],
        ['changed.png', 'base', baseSha, png.length],
        ['changed.png', 'head', headSha, png.length + 3],
      ] as const) {
        await expect(tools.call('review_read', { revision, path })).resolves.toMatchObject({ _tag: 'Unavailable', content: { _tag: 'Binary', oid: await git('rev-parse', `${sha}:${path}`), bytes: size } })
      }
      await expect(tools.call('review_read', { revision: 'base', path: 'added.data' })).resolves.toMatchObject({ _tag: 'Refused' })
      await expect(tools.call('review_read', { revision: 'head', path: 'removed.png' })).resolves.toMatchObject({ _tag: 'Refused' })
      await expect(tools.call('review_read', { revision: 'base', path: 'becomes-binary.ts' })).resolves.toMatchObject({ _tag: 'Read', text: 'old text\n' })
      await expect(tools.call('review_read', { revision: 'head', path: 'becomes-text.png' })).resolves.toMatchObject({ _tag: 'Read', text: 'new text\n' })
    },
  )
})

it('recognizes binary content after its initial probe without losing adjacent source', async () => {
  await revisionFixture({ 'source.ts': 'before\n' }, { 'source.ts': 'after\n', 'late-nul.png': Buffer.concat([Buffer.alloc(9000, 'x'), Buffer.from([0])]) }, async ({ root, baseSha, headSha }) => {
    const tools = await toolsForEvidence(root, baseSha, headSha)
    await expect(tools.call('review_read', { revision: 'head', path: 'late-nul.png' })).resolves.toMatchObject({ _tag: 'Unavailable', content: { _tag: 'Binary', bytes: 9001 } })
    await expect(tools.call('review_read', { revision: 'head', path: 'source.ts' })).resolves.toMatchObject({ _tag: 'Read', text: 'after\n' })
  })
})

it('returns binary-only changes without trying to emit their patch payload', async () => {
  await revisionFixture({ 'before.png': png }, { 'after.png': Buffer.concat([png, Buffer.from('after')]) }, async ({ root, baseSha, headSha, git }) => {
    const tools = await toolsForEvidence(root, baseSha, headSha)
    const diff = await tools.call('review_read', { revision: 'diff', path: '' }) as { _tag: string, text: string }
    expect(diff._tag).toBe('Read')
    expect(diff.text).toContain(await git('rev-parse', `${baseSha}:before.png`))
    expect(diff.text).toContain(await git('rev-parse', `${headSha}:after.png`))
    expect(diff.text).not.toContain('GIT binary patch')
  })
})

it('returns symlink metadata without treating its target as source or deletion', async () => {
  await revisionFixture({ 'source.ts': 'before\n' }, { 'source.ts': 'after\n' }, async ({ root, baseSha, git }) => {
    await symlink('/unavailable/target', join(root, 'link.ts'))
    await git('add', 'link.ts')
    await git('commit', '-m', 'test: add unavailable symlink')
    const headSha = await git('rev-parse', 'HEAD')
    const tools = await toolsForEvidence(root, baseSha, headSha)
    await expect(tools.call('review_read', { revision: 'head', path: 'link.ts' })).resolves.toMatchObject({ _tag: 'Unavailable', content: { _tag: 'Symlink', oid: await git('rev-parse', `${headSha}:link.ts`), bytes: Buffer.byteLength('/unavailable/target') } })
    await expect(tools.call('review_read', { revision: 'head', path: 'source.ts' })).resolves.toMatchObject({ _tag: 'Read', text: 'after\n' })
  })
})

it('still refuses text blobs beyond the per-blob limit', async () => {
  await revisionFixture({ 'source.ts': 'before\n' }, { 'source.ts': 'x'.repeat(1_000_001) }, async ({ root, baseSha, headSha }) => {
    await expect(collectReviewEvidence(root, baseSha, headSha)).rejects.toThrow('Changed text revision blobs exceed the Review evidence byte limit.')
  })
})

it('still refuses text revisions beyond the total byte limit', async () => {
  const before = Object.fromEntries(['one', 'two', 'three', 'four', 'five'].map(name => [`${name}.txt`, `${'x'.repeat(899_999)}a`]))
  const after = Object.fromEntries(['one', 'two', 'three', 'four', 'five'].map(name => [`${name}.txt`, `${'x'.repeat(899_999)}b`]))
  await revisionFixture(before, after, async ({ root, baseSha, headSha }) => {
    await expect(collectReviewEvidence(root, baseSha, headSha)).rejects.toThrow('Changed text revision blobs exceed the Review evidence byte limit.')
  })
})

it('still refuses a serialized artifact beyond the shared byte limit', async () => {
  const content = '\t'.repeat(900_000)
  await revisionFixture({ 'source.ts': 'before\n' }, { 'source.ts': 'after\n', 'one.txt': content, 'two.txt': content, 'three.txt': content }, async ({ root, baseSha, headSha }) => {
    await expect(collectReviewEvidence(root, baseSha, headSha)).resolves.toEqual({ _tag: 'Unavailable', reason: 'The serialized Review evidence exceeds 8000000 bytes.' })
  })
})
