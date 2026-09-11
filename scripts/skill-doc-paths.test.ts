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
