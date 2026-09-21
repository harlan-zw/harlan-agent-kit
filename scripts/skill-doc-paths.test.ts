import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const skillsDir = join(repoRoot, 'harlan-agent-kit', 'skills')

it('resolves every repository path quoted in a skill to a file in this repository', () => {
  const missing: string[] = []
  for (const skill of readdirSync(skillsDir)) {
    const file = join(skillsDir, skill, 'SKILL.md')
    if (!existsSync(file))
      continue
    const quoted = readFileSync(file, 'utf8').match(/`[^`\n]+`/g) ?? []
    for (const tick of quoted) {
      const quotedPath = tick.slice(1, -1)
      if (!quotedPath.startsWith('harlan-agent-kit/') || quotedPath.includes('<'))
        continue
      if (!existsSync(join(repoRoot, quotedPath)))
        missing.push(`${quotedPath} in ${skill}/SKILL.md`)
    }
  }
  expect(missing).toEqual([])
})

it('publishes no skill output to the retired scratch notes path', () => {
  const retired: string[] = []
  function scan(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory())
        scan(path)
      else if (readFileSync(path, 'utf8').includes('~/scratch/notes/'))
        retired.push(path)
    }
  }
  scan(skillsDir)
  expect(retired).toEqual([])
})

it('claims no enforcement of the root docs contract that the contract disclaims', () => {
  const contract = readFileSync(join(repoRoot, 'harlan-agent-kit', 'references', 'root-docs.md'), 'utf8')
  const agents = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8')
  const enforcement = contract.split('## Enforcement')[1] ?? ''
  if (!/nothing enforces this contract yet/i.test(enforcement))
    return
  const claimants = [...agents.matchAll(/([^\s`]+)`?\s+enforces?\s+it\b/gi)]
    .map(match => match[1])
    .filter(subject => !/^(?:nothing|nobody|no one|none)$/i.test(subject))
  expect(claimants).toEqual([])
})
