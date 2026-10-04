import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import source from '../harlan-agent-kit/brundlefly.json' with { type: 'json' }

interface SkillSource {
  repository: string
  revision: string
  skills: readonly string[]
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** Restore one immutable source, then expose its Skills through provider discovery. */
export async function syncBrundlefly(input: { source: SkillSource, home: string, claudeHome: string }): Promise<string[]> {
  if (!/^[a-f0-9]{40}$/.test(input.source.revision)
    || input.source.skills.length === 0
    || new Set(input.source.skills).size !== input.source.skills.length
    || input.source.skills.some(name => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) {
    throw new Error('The Brundlefly source needs an exact commit and unique Skill names.')
  }

  const cache = join(input.home, '.local/share/harlan-agent-kit/brundlefly')
  const checkout = join(cache, input.source.revision)
  const directories = input.source.skills.map(name => join(checkout, 'skills', name))
  const targets = input.source.skills.flatMap((name, index) => [
    { path: join(input.home, '.agents/skills', name), source: directories[index]! },
    { path: join(input.claudeHome, 'skills', name), source: directories[index]! },
  ])

  // Refuse a conflict before changing any provider target. Only our cache links may move.
  for (const target of targets) {
    const metadata = await lstat(target.path).catch((error: unknown) => {
      if (missing(error))
        return undefined
      throw error
    })
    if (metadata === undefined)
      continue
    if (!metadata.isSymbolicLink())
      throw new Error(`The Skill target already exists: ${target.path}`)
    const current = resolve(dirname(target.path), await readlink(target.path))
    const within = relative(cache, current)
    if (within.startsWith('..') || isAbsolute(within) || within === '')
      throw new Error(`The Skill target already exists outside the Brundlefly cache: ${target.path}`)
  }

  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: 120_000,
  }).trim()
  const exists = await lstat(checkout).then(() => true).catch((error: unknown) => {
    if (missing(error))
      return false
    throw error
  })
  if (!exists) {
    await mkdir(cache, { recursive: true })
    const staging = await mkdtemp(join(cache, '.restore-'))
    try {
      git(staging, 'init', '--quiet')
      git(staging, 'sparse-checkout', 'set', '--no-cone', ...input.source.skills.map(name => `/skills/${name}/`))
      git(staging, '-c', 'credential.interactive=never', 'fetch', '--quiet', '--depth=1', input.source.repository, input.source.revision)
      git(staging, 'checkout', '--quiet', '--detach', input.source.revision)
      await checkSkills(staging, input.source.skills)
      await rename(staging, checkout)
    }
    finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  if (git(checkout, 'rev-parse', 'HEAD') !== input.source.revision || git(checkout, 'status', '--porcelain', '--untracked-files=all') !== '')
    throw new Error(`The Brundlefly cache differs from its pinned commit: ${checkout}`)
  await checkSkills(checkout, input.source.skills)

  for (const target of targets) {
    await mkdir(dirname(target.path), { recursive: true })
    const staging = await mkdtemp(join(dirname(target.path), '.brundlefly-'))
    try {
      const link = join(staging, 'skill')
      await symlink(target.source, link, 'dir')
      await rename(link, target.path)
    }
    finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  return directories
}

async function checkSkills(checkout: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const text = await readFile(join(checkout, 'skills', name, 'SKILL.md'), 'utf8')
    if (!text.startsWith('---\n') || !text.split('\n---')[0]?.split('\n').includes(`name: ${name}`))
      throw new Error(`The Brundlefly Skill name does not match its directory: ${name}`)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const home = process.env.HARLAN_AGENT_CONTEXT_HOME ?? process.env.HOME ?? homedir()
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude')
  const directories = await syncBrundlefly({ source, home, claudeHome })
  console.log(`Restored Brundlefly ${source.revision}: ${directories.length} Skills.`)
}
