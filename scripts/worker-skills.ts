import type { Stats } from 'node:fs'
import type { Result } from '../packages/harlan-github-agent/src/result.ts'
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import manifest from '../.skills/skilld.json' with { type: 'json' }
import { err, ok } from '../packages/harlan-github-agent/src/result.ts'

interface WorkerSkillInput {
  sourceRoot: string
  workerHome: string
  skills: readonly string[]
}

const relativeDestination = '.local/share/harlan-agent-kit/skilld/skills'
const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`)

/** Missing optional directories are normal. Other filesystem failures stop preparation. */
async function metadata(path: string): Promise<Stats | undefined> {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return undefined
    throw error
  })
}

async function checkSource(path: string, root: string, ancestors: readonly string[] = []): Promise<Result<void, string>> {
  const canonical = await realpath(path)
  if (!within(canonical, root) || ancestors.includes(canonical))
    return err(`The Skill source escapes its directory or contains a cycle: ${path}`)
  const info = await stat(canonical)
  if (info.isFile())
    return ok(undefined)
  if (!info.isDirectory())
    return err(`The Skill source must contain ordinary files and directories: ${path}`)
  for (const name of await readdir(path)) {
    const checked = await checkSource(join(path, name), root, [...ancestors, canonical])
    if (checked._tag === 'Err')
      return checked
  }
  return ok(undefined)
}

async function makePrivate(path: string): Promise<void> {
  const info = await lstat(path)
  await chmod(path, info.isDirectory() || (info.mode & 0o111) !== 0 ? 0o700 : 0o600)
  if (info.isDirectory()) {
    for (const name of await readdir(path)) await makePrivate(join(path, name))
  }
}

/** Refresh declared Skill copies only. Service updates call this after active Agents drain. */
export async function refreshWorkerSkills(input: WorkerSkillInput, move: typeof rename = rename): Promise<Result<readonly string[], string>> {
  const names = [...new Set(input.skills)]
  if (names.some(name => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)))
    return err('Each declared Skill must use its directory name.')
  if (!isAbsolute(input.sourceRoot) || !isAbsolute(input.workerHome))
    return err('The Skill source and Agent home paths must be absolute.')
  const sourceRoot = await realpath(input.sourceRoot)
  const workerHome = await realpath(input.workerHome)
  if (workerHome !== resolve(input.workerHome) || within(sourceRoot, workerHome) || within(workerHome, sourceRoot))
    return err('The Skill source and Agent home must use separate ordinary directories.')
  const destination = join(workerHome, relativeDestination)
  let current = workerHome
  for (const name of relativeDestination.split('/')) {
    current = join(current, name)
    const info = await metadata(current)
    if (info !== undefined && (!info.isDirectory() || info.isSymbolicLink()))
      return err(`The Agent Skill destination must use ordinary directories: ${current}`)
  }
  for (const name of names) {
    const source = join(sourceRoot, name)
    if (await metadata(join(source, 'SKILL.md')) === undefined || !(await stat(join(source, 'SKILL.md'))).isFile())
      return err(`The declared Skill is missing: ${name}`)
    const canonical = await realpath(source)
    if (!within(canonical, sourceRoot))
      return err(`The declared Skill escapes its source: ${name}`)
    const checked = await checkSource(source, canonical)
    if (checked._tag === 'Err')
      return checked
    const existing = await metadata(join(destination, name))
    if (existing !== undefined && (!existing.isDirectory() || existing.isSymbolicLink()))
      return err(`The Agent Skill destination must use an ordinary directory: ${name}`)
  }
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(destination, '.refresh-'))
  const changes: Array<{ path: string, backup: string, previous: boolean, installed: boolean }> = []
  let cleanup = true
  try {
    const prepared = join(staging, 'prepared')
    await mkdir(prepared, { mode: 0o700 })
    await mkdir(join(staging, 'previous'), { mode: 0o700 })
    // Stage every complete directory before replacing any existing Skill.
    for (const name of names) {
      await cp(join(sourceRoot, name), join(prepared, name), { recursive: true, dereference: true })
      await makePrivate(join(prepared, name))
    }
    for (const name of names) {
      const change = { path: join(destination, name), backup: join(staging, 'previous', name), previous: false, installed: false }
      changes.push(change)
      if (await metadata(change.path) !== undefined) {
        await move(change.path, change.backup)
        change.previous = true
      }
      await move(join(prepared, name), change.path)
      change.installed = true
    }
    return ok(names)
  }
  catch (cause) {
    // Restore complete old copies if publication fails. Keep backups if recovery fails.
    const rollbackErrors: unknown[] = []
    for (const change of changes.reverse()) {
      await (async () => {
        if (change.installed)
          await rm(change.path, { recursive: true })
        if (change.previous)
          await move(change.backup, change.path)
      })().catch(error => rollbackErrors.push(error))
    }
    if (rollbackErrors.length > 0) {
      cleanup = false
      throw new AggregateError([cause, ...rollbackErrors], `The previous Skill copies require recovery from ${staging}.`)
    }
    throw cause
  }
  finally {
    if (cleanup)
      await rm(staging, { recursive: true })
  }
}

/** A desktop without an isolated worker has no copies to refresh. */
export async function refreshConfiguredWorkerSkills(input: {
  profilePath: string
  sourceRoot: string
  skills: readonly string[]
}): Promise<Result<{ _tag: 'NotConfigured' } | { _tag: 'Refreshed', skills: readonly string[] }, string>> {
  const profile = await readFile(input.profilePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return undefined
    throw error
  })
  if (profile === undefined)
    return ok({ _tag: 'NotConfigured' })
  const parsed: unknown = JSON.parse(profile)
  if (parsed === null || typeof parsed !== 'object' || !('home' in parsed) || typeof parsed.home !== 'string')
    return err('The Agent worker configuration requires its home path.')
  const refreshed = await refreshWorkerSkills({ sourceRoot: input.sourceRoot, workerHome: parsed.home, skills: input.skills })
  return refreshed._tag === 'Err' ? refreshed : ok({ _tag: 'Refreshed', skills: refreshed.value })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2)
    throw new Error('Run worker-skills without arguments.')
  const result = await refreshConfiguredWorkerSkills({
    profilePath: join(homedir(), '.config/harlan-github-agent/worker.json'),
    sourceRoot: join(homedir(), '.local/share/harlan-agent-kit/skilld/skills'),
    skills: Object.keys(manifest.skills),
  })
  if (result._tag === 'Err')
    throw new Error(result.error)
  if (result.value._tag === 'Refreshed')
    process.stdout.write(`Agent Skills refreshed: ${result.value.skills.length}.\n`)
}
