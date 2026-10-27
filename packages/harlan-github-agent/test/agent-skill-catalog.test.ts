import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { agentSkillCatalogPrompt, loadAgentSkillCatalog } from '../src/agent-skill-catalog.ts'

it('reports missing optional Skill roots without inventing a location', async () => {
  const root = await mkdtemp(join(tmpdir(), 'missing-agent-skills-'))
  try {
    const catalog = await loadAgentSkillCatalog([{ path: join(root, 'absent'), agentPath: '/home/agent/.agents/skills' }])
    expect(catalog).toContain('No installed Harlan Agent Kit Skills are available in this Agent.')
    expect(catalog).not.toContain('/home/agent/.agents/skills')
  }
  finally {
    await rm(root, { recursive: true })
  }
})

it('bounds Skill metadata enumeration before returning a partial catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bounded-agent-skills-'))
  try {
    await Promise.all(Array.from({ length: 513 }, (_, index) => mkdir(join(root, `skill-${index}`))))
    await expect(loadAgentSkillCatalog([{ path: root, agentPath: '/home/agent/skills' }]))
      .rejects
      .toThrow('The Skill catalog exceeds 512 entries in one directory.')
  }
  finally {
    await rm(root, { recursive: true })
  }
})

it.skipIf(process.getuid?.() === 0)('surfaces unreadable installed roots instead of silently dropping Skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unreadable-agent-skills-'))
  try {
    await chmod(root, 0o000)
    await expect(loadAgentSkillCatalog([{ path: root, agentPath: '/home/agent/skills' }]))
      .rejects
      .toMatchObject({ code: 'EACCES' })
  }
  finally {
    await chmod(root, 0o700)
    await rm(root, { recursive: true })
  }
})

it.skipIf(process.getuid?.() === 0)('refuses to advertise an installed Skill the Agent cannot read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unreadable-agent-skill-'))
  const directory = join(root, 'blocked')
  const skill = join(directory, 'SKILL.md')
  try {
    await mkdir(directory)
    await writeFile(skill, 'Unavailable instructions.', { mode: 0o000 })
    await expect(loadAgentSkillCatalog([{ path: root, agentPath: '/home/agent/skills' }]))
      .rejects
      .toMatchObject({ code: 'EACCES' })
  }
  finally {
    await chmod(skill, 0o600)
    await rm(root, { recursive: true })
  }
})

it('preserves complete model input and gives no catalog advice without an available catalog', () => {
  const prompt = 'Large evidence 🐛\n'.repeat(16_000)
  expect(agentSkillCatalogPrompt(prompt, undefined)).toBe(prompt)
  expect(agentSkillCatalogPrompt(prompt, '/run/agent/SKILLS.md')).toBe(`Read /run/agent/SKILLS.md for exact installed Skill paths. Use listed files. Report a required missing Skill. Do not search other home directories.\n\n${prompt}`)
})
