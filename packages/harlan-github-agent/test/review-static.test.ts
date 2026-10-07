import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createReviewStaticReader } from '../src/review-static.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('bounds directory entries even when every entry is an ignored symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-static-entries-'))
  roots.push(root)
  await Promise.all(Array.from({ length: 4001 }, (_, index) => symlink('/etc', join(root, `ignored-${index}`))))
  expect(await createReviewStaticReader(root).search('needle')).toEqual({ _tag: 'Matches', matches: [], truncated: true })
})

it('refuses secret symlinks, nested directory aliases, and absolute escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-static-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const privateHome = join(root, 'controller')
  await Promise.all([mkdir(workspace), mkdir(privateHome)])
  await writeFile(join(privateHome, 'token'), 'fake-controller-secret')
  await writeFile(join(workspace, 'source.ts'), 'export const safe = true')
  await symlink(join(privateHome, 'token'), join(workspace, 'token'))
  await symlink(privateHome, join(workspace, 'alias'))
  const reader = createReviewStaticReader(workspace)
  expect(await reader.read('source.ts')).toEqual({ _tag: 'Read', text: 'export const safe = true', truncated: false })
  for (const path of ['token', 'alias/token', '../controller/token', join(privateHome, 'token')])
    expect((await reader.read(path))._tag).toBe('Refused')
})

it('bounds file reads and searches without traversing symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-static-'))
  roots.push(root)
  await writeFile(join(root, 'large.ts'), 'x'.repeat(20_000))
  await writeFile(join(root, 'match.ts'), 'export const needle = 1')
  await symlink('/etc', join(root, 'external'))
  const reader = createReviewStaticReader(root)
  const read = await reader.read('large.ts')
  expect(read._tag).toBe('Read')
  if (read._tag === 'Read') {
    expect(read.text.length).toBe(16_000)
    expect(read.truncated).toBe(true)
  }
  const search = await reader.search('needle')
  expect(search._tag).toBe('Matches')
  if (search._tag === 'Matches')
    expect(search.matches).toEqual([{ path: 'match.ts', line: 1, text: 'export const needle = 1' }])
})
