import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createReviewTools } from '../src/review-tools.ts'

it('discovers and reads unchanged callers beyond the search traversal cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-tools-callers-'))
  try {
    await mkdir(join(root, 'unchanged'))
    await Promise.all(Array.from({ length: 4101 }, (_, index) => writeFile(join(root, `unrelated-${index}.ts`), 'export {}')))
    const caller = `${'// padding\n'.repeat(2000)}changedApi()`
    await writeFile(join(root, 'unchanged', 'caller.ts'), caller)
    const tools = createReviewTools({ workspace: root, proof: async () => {
      throw new Error('Discovery must not spend the proof')
    } })
    expect(await tools.call('review_search', { text: 'changedApi' })).toMatchObject({ matches: [], truncated: true })

    const directories = ['']
    const files: string[] = []
    while (directories.length > 0) {
      const path = directories.shift()!
      let offset = 0
      for (;;) {
        const page = await tools.call('review_read', { revision: 'tree', path, offset }) as { _tag: string, entries: { path: string, kind: string }[], nextOffset?: number }
        expect(page._tag).toBe('Listed')
        for (const entry of page.entries)
          (entry.kind === 'directory' ? directories : files).push(entry.path)
        if (page.nextOffset === undefined)
          break
        expect(page.nextOffset).toBeGreaterThan(offset)
        offset = page.nextOffset
      }
    }
    expect(files).toContain('unchanged/caller.ts')
    let source = ''
    let offset = 0
    for (;;) {
      const page = await tools.call('review_read', { path: 'unchanged/caller.ts', offset }) as { text: string, nextOffset?: number }
      source += page.text
      if (page.nextOffset === undefined)
        break
      offset = page.nextOffset
    }
    expect(source).toBe(caller)
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps paginated tree discovery inside the Review workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-tools-tree-'))
  try {
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    await mkdir(join(root, 'private'))
    await writeFile(join(root, 'private', 'secret'), 'fixture-private-data')
    await symlink(join(root, 'private'), join(workspace, 'alias'))
    await mkdir(join(workspace, '.git'))
    await mkdir(join(workspace, 'node_modules'))
    await writeFile(join(workspace, 'caller.ts'), 'changedApi()')
    const tools = createReviewTools({ workspace, proof: async () => null })
    expect(await tools.call('review_read', { revision: 'tree', path: '' })).toMatchObject({
      _tag: 'Listed',
      entries: [{ path: 'caller.ts', kind: 'file' }],
      truncated: false,
    })
    for (const path of ['alias', '../private', join(root, 'private'), '.git', 'node_modules'])
      expect(await tools.call('review_read', { revision: 'tree', path })).toMatchObject({ _tag: 'Refused' })
    expect(await tools.call('review_read', { revision: 'tree', path: '', offset: -1 })).toMatchObject({ _tag: 'Refused' })
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

it('advances tree pages through ignored entries without losing source paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-tools-ignored-'))
  try {
    await Promise.all(Array.from({ length: 401 }, (_, index) => symlink('/etc', join(root, `ignored-${index}`))))
    await writeFile(join(root, 'caller.ts'), 'changedApi()')
    const tools = createReviewTools({ workspace: root, proof: async () => null })
    const first = await tools.call('review_read', { revision: 'tree', path: '' }) as { entries: { path: string }[], nextOffset: number }
    expect(first.nextOffset).toBeGreaterThan(0)
    const second = await tools.call('review_read', { revision: 'tree', path: '', offset: first.nextOffset }) as { entries: { path: string }[], truncated: boolean }
    expect([...first.entries, ...second.entries]).toEqual([{ path: 'caller.ts', kind: 'file' }])
    expect(second.truncated).toBe(false)
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

it('pages late workspace code and immutable deleted base evidence without spending a proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-tools-evidence-'))
  try {
    await writeFile(join(root, 'large.ts'), `${'x'.repeat(64_000)}late code`)
    const artifact = join(root, 'evidence.json')
    await writeFile(artifact, JSON.stringify({ _tag: 'Available', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), mergeBaseSha: 'a'.repeat(40), diff: 'deleted old.ts', files: { 'old.ts': { base: { _tag: 'Text', oid: 'c'.repeat(40), bytes: 20, text: 'deleted exported API' }, head: { _tag: 'Missing' } } } }))
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
