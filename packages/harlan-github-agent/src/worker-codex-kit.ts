import { readFile, stat } from 'node:fs/promises'
import { join, normalize } from 'node:path'

const kitName = 'harlan-agent-kit'

/** The kit's Codex Skills and guards, read from a read-only mount the controller trusts. */
export interface CodexKit {
  name: string
  /** The host directory that holds the kit Skills. */
  skills: string
  /** Codex hooks with the kit root filled in, as JSON. */
  hooks: string
}

async function optionalFile(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      return undefined
    throw error
  })
}

function withPluginRoot(value: unknown, root: string): unknown {
  if (typeof value === 'string')
    // eslint-disable-next-line no-template-curly-in-string -- Codex hook files name the plugin root literally.
    return value.replaceAll('${CLAUDE_PLUGIN_ROOT}', root)
  if (Array.isArray(value))
    return value.map(item => withPluginRoot(item, root))
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withPluginRoot(item, root)]))
  return value
}

/**
 * Finds the kit among the worker's read-only mounts. Never reads the shared worker home.
 * Returns undefined when no mount holds it, so the turn runs without the kit.
 */
export async function resolveCodexKit(mounts: readonly { path: string, source: string }[]): Promise<CodexKit | undefined> {
  for (const mount of mounts) {
    const manifest = await optionalFile(join(mount.source, '.codex-plugin/plugin.json'))
    if (manifest === undefined)
      continue
    const { name, skills } = JSON.parse(manifest) as { name?: unknown, skills?: unknown }
    if (name !== kitName)
      continue
    const relative = normalize(typeof skills === 'string' ? skills : 'skills')
    if (relative.startsWith('..') || relative.startsWith('/'))
      throw new Error('The kit Skills must stay inside the kit directory.')
    const skillsDirectory = join(mount.source, relative)
    if (!(await stat(skillsDirectory)).isDirectory())
      throw new Error('The kit Skills path must be a directory.')
    const hooks = await optionalFile(join(mount.source, 'hooks/codex.json'))
    const parsed = hooks === undefined ? { hooks: {} } : JSON.parse(hooks) as unknown
    if (typeof parsed !== 'object' || parsed === null || !('hooks' in parsed))
      throw new Error('The kit Codex hooks need a hooks object.')
    // Hook commands run the kit scripts at the path the sandbox mounts read only.
    return { name, skills: skillsDirectory, hooks: JSON.stringify(withPluginRoot(parsed, mount.path)) }
  }
  return undefined
}
