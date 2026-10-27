import { constants } from 'node:fs'
import { access, lstat, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

export const AGENT_SKILL_CATALOG_PATH = '/run/agent/SKILLS.md'

export interface AgentSkillRoot {
  /** An existing source directory already exposed by the sandbox. */
  path: string
  /** The same directory's path inside the Agent namespace. */
  agentPath: string
}

const maximumEntries = 512
const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

async function ordinary(path: string, kind: 'directory' | 'file'): Promise<boolean> {
  const metadata = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
    // Optional roots and directories without SKILL.md are not installed Skills.
    if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')
      return null
    throw cause
  })
  return metadata !== null && (kind === 'directory' ? metadata.isDirectory() : metadata.isFile())
}

/** Enumerate only ordinary Skill files under already exposed roots, in priority order. */
export async function loadAgentSkillCatalog(roots: readonly AgentSkillRoot[]): Promise<string> {
  const skills = new Map<string, string>()
  for (const root of roots) {
    if (!isAbsolute(root.path) || !isAbsolute(root.agentPath))
      throw new Error('The Skill catalog requires absolute source and Agent paths.')
    if (!await ordinary(root.path, 'directory') || await realpath(root.path) !== resolve(root.path))
      continue
    const names: string[] = []
    let entries = 0
    for await (const entry of await opendir(root.path)) {
      if (++entries > maximumEntries)
        throw new Error('The Skill catalog exceeds 512 entries in one directory.')
      if (entry.isDirectory() && entry.name.length <= 128 && skillName.test(entry.name))
        names.push(entry.name)
    }
    for (const name of names.sort()) {
      if (skills.has(name))
        continue
      const path = join(root.path, name, 'SKILL.md')
      // Reject aliases, including absolute host aliases that break inside the Agent home.
      if (!await ordinary(path, 'file') || await realpath(path) !== path)
        continue
      await access(path, constants.R_OK)
      skills.set(name, join(root.agentPath, name, 'SKILL.md'))
    }
  }
  return [
    '# Installed Harlan Agent Kit Skills',
    '',
    'Paths are JSON-quoted. Read References relative to the listed Skill directory.',
    '',
    ...[...skills].sort(([left], [right]) => left.localeCompare(right)).map(([name, path]) => `- ${name}: ${JSON.stringify(path)}`),
    ...(skills.size === 0 ? ['No installed Harlan Agent Kit Skills are available in this Agent.'] : []),
    '',
  ].join('\n')
}

/** Give each model one bounded pointer instead of repeating the full catalog. */
export function agentSkillCatalogPrompt(prompt: string, path: string | undefined): string {
  return path === undefined
    ? prompt
    : `Read ${path} for exact installed Skill paths. Use listed files. Report a required missing Skill. Do not search other home directories.\n\n${prompt}`
}
