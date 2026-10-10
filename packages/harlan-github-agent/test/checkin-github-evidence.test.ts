import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { writeCheckinGitHubEvidence } from '../src/checkin-github-evidence.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function workspace() {
  const path = await mkdtemp(join(tmpdir(), 'checkin-evidence-'))
  roots.push(path)
  await mkdir(join(path, 'node_modules'))
  return path
}
const evidence = { observedAt: '2026-10-10T07:00:00Z', workflowRuns: { _tag: 'Available' as const, entries: [{ id: 12, name: 'CI' }], truncated: false } }

it('delivers scoped metadata through a private collector file', async () => {
  const root = await workspace()
  await writeCheckinGitHubEvidence({ workspace: root, repository: 'harlan-zw/example', branch: 'main', evidence })
  const path = join(root, 'node_modules/.cache/harlan-checkin/github.json')
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ schemaVersion: 1, repository: 'harlan-zw/example', branch: 'main', ...evidence })
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  await writeCheckinGitHubEvidence({ workspace: root, repository: 'harlan-zw/example', branch: 'main', evidence: { ...evidence, observedAt: '2026-10-10T07:01:00Z' } })
  expect(JSON.parse(await readFile(path, 'utf8')).observedAt).toBe('2026-10-10T07:01:00Z')
})

it('refuses a cache symlink outside its task Worktree', async () => {
  const root = await workspace()
  const outside = await workspace()
  await symlink(outside, join(root, 'node_modules/.cache'))
  await expect(writeCheckinGitHubEvidence({ workspace: root, repository: 'harlan-zw/example', branch: 'main', evidence })).rejects.toThrow('inside its Worktree')
  await expect(stat(join(outside, 'harlan-checkin'))).rejects.toMatchObject({ code: 'ENOENT' })
})
