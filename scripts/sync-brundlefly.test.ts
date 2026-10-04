import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { syncBrundlefly } from './sync-brundlefly.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'brundlefly-'))
  roots.push(root)
  const repository = join(root, 'source')
  await mkdir(join(repository, 'skills/write-human/references'), { recursive: true })
  await writeFile(join(repository, 'skills/write-human/SKILL.md'), '---\nname: write-human\ndescription: Edit prose.\n---\nRead references/rules.md.\n')
  await writeFile(join(repository, 'skills/write-human/references/rules.md'), 'Preserve facts.\n')
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim()
  git('init', '--quiet')
  git('add', '.')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--quiet', '-m', 'feat: add fixture')
  return { root, repository, revision: git('rev-parse', 'HEAD'), skills: ['write-human'] }
}

it('restores the pinned skill and bundled references for both providers', async () => {
  const source = await fixture()
  const home = join(source.root, 'home')
  await writeFile(join(source.repository, 'skills/write-human/references/rules.md'), 'Changed after the commit.\n')
  const directories = await syncBrundlefly({ source, home, claudeHome: join(home, '.claude') })
  for (const directory of [directories[0]!, join(home, '.agents/skills/write-human'), join(home, '.claude/skills/write-human')])
    expect(await readFile(join(directory, 'references/rules.md'), 'utf8')).toBe('Preserve facts.\n')
  await expect(syncBrundlefly({ source, home, claudeHome: join(home, '.claude') })).resolves.toEqual(directories)
})

it('preserves an unrelated installed skill when names conflict', async () => {
  const source = await fixture()
  const home = join(source.root, 'home')
  const target = join(home, '.agents/skills/write-human')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'SKILL.md'), 'User-owned Skill.\n')
  await expect(syncBrundlefly({ source, home, claudeHome: join(home, '.claude') })).rejects.toThrow('already exists')
  expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('User-owned Skill.\n')
})

it('refuses a missing skill without creating provider links', async () => {
  const source = await fixture()
  const home = join(source.root, 'home')
  await expect(syncBrundlefly({ source: { ...source, skills: ['missing'] }, home, claudeHome: join(home, '.claude') })).rejects.toThrow()
  await expect(readFile(join(home, '.agents/skills/missing/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses a changed cache instead of running altered instructions', async () => {
  const source = await fixture()
  const home = join(source.root, 'home')
  const directories = await syncBrundlefly({ source, home, claudeHome: join(home, '.claude') })
  await writeFile(join(directories[0]!, 'SKILL.md'), 'Altered instructions.\n')
  await expect(syncBrundlefly({ source, home, claudeHome: join(home, '.claude') })).rejects.toThrow('differs from its pinned commit')
})
