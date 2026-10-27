import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { refreshConfiguredWorkerSkills, refreshWorkerSkills } from './worker-skills.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'worker-skills-'))
  roots.push(root)
  const sourceRoot = join(root, 'host-skills')
  const workerHome = join(root, 'worker')
  const destination = join(workerHome, '.local/share/harlan-agent-kit/skilld/skills')
  await mkdir(sourceRoot, { recursive: true })
  await mkdir(destination, { recursive: true })
  const file = async (path: string, value: string) => {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, value)
  }
  await file(join(sourceRoot, 'writing/SKILL.md'), 'Current writing rules.')
  await file(join(sourceRoot, 'writing/references/clarity.md'), 'Current reference.')
  await file(join(destination, 'writing/SKILL.md'), 'Old writing rules.')
  await file(join(destination, 'writing/obsolete.md'), 'Old extra file.')
  return { root, sourceRoot, workerHome, destination, file }
}

it('refreshes a complete Skill and References while preserving unrelated worker files', async () => {
  const { sourceRoot, workerHome, destination, file } = await fixture()
  const untouched = ['.codex/auth.json', '.codex/AGENTS.md', '.config/opencode/opencode.json', 'worker.json', '.local/share/harlan-agent-kit/skilld/skills/custom/SKILL.md']
  for (const path of untouched) await file(join(workerHome, path), `Preserve ${path}`)
  expect(await refreshWorkerSkills({ sourceRoot, workerHome, skills: ['writing'] })).toEqual({ _tag: 'Ok', value: ['writing'] })
  expect(await readFile(join(destination, 'writing/SKILL.md'), 'utf8')).toBe('Current writing rules.')
  expect(await readFile(join(destination, 'writing/references/clarity.md'), 'utf8')).toBe('Current reference.')
  await expect(readFile(join(destination, 'writing/obsolete.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  for (const path of untouched) expect(await readFile(join(workerHome, path), 'utf8')).toBe(`Preserve ${path}`)
})

it('prepares every declared Skill before changing any current copy', async () => {
  const { sourceRoot, workerHome, destination } = await fixture()
  expect(await refreshWorkerSkills({ sourceRoot, workerHome, skills: ['writing', 'missing'] })).toMatchObject({ _tag: 'Err' })
  expect(await readFile(join(destination, 'writing/SKILL.md'), 'utf8')).toBe('Old writing rules.')
})

it.each(['previous', 'prepared'])('refreshes the valid Skill name %s', async (name) => {
  const { sourceRoot, workerHome, destination, file } = await fixture()
  await file(join(sourceRoot, name, 'SKILL.md'), 'Valid named Skill.')
  expect(await refreshWorkerSkills({ sourceRoot, workerHome, skills: [name] })).toEqual({ _tag: 'Ok', value: [name] })
  expect(await readFile(join(destination, name, 'SKILL.md'), 'utf8')).toBe('Valid named Skill.')
})

it('rejects a Skill whose required entry is a directory', async () => {
  const { sourceRoot, workerHome, destination } = await fixture()
  await rm(join(sourceRoot, 'writing/SKILL.md'))
  await mkdir(join(sourceRoot, 'writing/SKILL.md'))
  expect(await refreshWorkerSkills({ sourceRoot, workerHome, skills: ['writing'] })).toMatchObject({ _tag: 'Err' })
  expect(await readFile(join(destination, 'writing/SKILL.md'), 'utf8')).toBe('Old writing rules.')
})

it('restores every previous complete copy if publication fails', async () => {
  const { sourceRoot, workerHome, destination, file } = await fixture()
  await file(join(sourceRoot, 'review/SKILL.md'), 'New review rules.')
  await file(join(destination, 'review/SKILL.md'), 'Old review rules.')
  const failure = new Error('Filesystem publication failed.')
  const move: typeof rename = async (source, target) => {
    if (String(source).includes('.refresh-') && !String(source).includes('/previous/') && String(source).endsWith('/review') && target === join(destination, 'review'))
      throw failure
    await rename(source, target)
  }
  await expect(refreshWorkerSkills({ sourceRoot, workerHome, skills: ['writing', 'review'] }, move)).rejects.toBe(failure)
  expect(await readFile(join(destination, 'writing/SKILL.md'), 'utf8')).toBe('Old writing rules.')
  expect(await readFile(join(destination, 'review/SKILL.md'), 'utf8')).toBe('Old review rules.')
})

it('copies contained Reference aliases as ordinary readable files', async () => {
  const { sourceRoot, workerHome, destination } = await fixture()
  await symlink('references/clarity.md', join(sourceRoot, 'writing/linked.md'))
  expect(await refreshWorkerSkills({ sourceRoot, workerHome, skills: ['writing'] })).toMatchObject({ _tag: 'Ok' })
  expect(await readFile(join(destination, 'writing/linked.md'), 'utf8')).toBe('Current reference.')
})

it('rejects an escaping source alias before changing the worker', async () => {
  const { root, sourceRoot, workerHome, destination, file } = await fixture()
  await file(join(root, 'private-token'), 'Private token fixture.')
  await symlink(join(root, 'private-token'), join(sourceRoot, 'writing/leak.md'))
  expect(await refreshWorkerSkills({ sourceRoot, workerHome, skills: ['writing'] })).toMatchObject({ _tag: 'Err' })
  expect(await readFile(join(destination, 'writing/SKILL.md'), 'utf8')).toBe('Old writing rules.')
})

it.each(['skill', 'ancestor'])('rejects an escaping destination %s alias', async (alias) => {
  const { root, sourceRoot, workerHome, destination, file } = await fixture()
  const external = join(root, 'external')
  await file(join(external, 'SKILL.md'), 'Leave external files unchanged.')
  const target = alias === 'skill' ? join(destination, 'writing') : join(workerHome, '.local')
  await rm(target, { recursive: true })
  await symlink(external, target)
  expect(await refreshWorkerSkills({ sourceRoot, workerHome, skills: ['writing'] })).toMatchObject({ _tag: 'Err' })
  expect(await readFile(join(external, 'SKILL.md'), 'utf8')).toBe('Leave external files unchanged.')
})

it.each(['../escape', '', 'writing/child'])('rejects unsafe declared Skill name %j', async (name) => {
  const { sourceRoot, workerHome, destination } = await fixture()
  expect(await refreshWorkerSkills({ sourceRoot, workerHome, skills: [name] })).toMatchObject({ _tag: 'Err' })
  expect(await readFile(join(destination, 'writing/SKILL.md'), 'utf8')).toBe('Old writing rules.')
})

it('leaves a host without an isolated worker unchanged', async () => {
  const { root, sourceRoot } = await fixture()
  expect(await refreshConfiguredWorkerSkills({ profilePath: join(root, 'absent-worker.json'), sourceRoot, skills: ['writing'] }))
    .toEqual({ _tag: 'Ok', value: { _tag: 'NotConfigured' } })
})

it('uses only the configured worker home and preserves its full profile', async () => {
  const { root, sourceRoot, workerHome, destination, file } = await fixture()
  const profilePath = join(root, 'worker.json')
  const profile = JSON.stringify({ home: workerHome, tools: ['/tools'], codex: '/codex', opencode: '/opencode', readOnlyPaths: ['/plugin'] })
  await file(profilePath, profile)
  expect(await refreshConfiguredWorkerSkills({ profilePath, sourceRoot, skills: ['writing'] }))
    .toEqual({ _tag: 'Ok', value: { _tag: 'Refreshed', skills: ['writing'] } })
  expect(await readFile(profilePath, 'utf8')).toBe(profile)
  expect(await readFile(join(destination, 'writing/SKILL.md'), 'utf8')).toBe('Current writing rules.')
})
