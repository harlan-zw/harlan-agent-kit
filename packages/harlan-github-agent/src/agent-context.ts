import type { Result } from './result.ts'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { err, ok } from './result.ts'

export interface AgentContextPaths {
  /** Harlan's Claude Code home, which holds the per-repository memory. */
  claudeHome: string
  instructionsPath: string
  skillsRoot: string
}

export interface AgentContext {
  claudeHome: string
  instructionPaths: readonly string[]
  skillDirectories: readonly string[]
}

interface OpencodeConfiguration {
  [key: string]: unknown
  instructions?: unknown
  skills?: unknown
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function opencodePath(environment: NodeJS.ProcessEnv): string {
  const installationDirectory = join(environment.HOME ?? homedir(), '.opencode', 'bin')
  const configuredDirectories = (environment.PATH ?? '')
    .split(delimiter)
    .filter(directory => directory.length > 0)
  return unique([installationDirectory, ...configuredDirectories]).join(delimiter)
}

/** Resolves the context shared by every local Agent provider. */
export function defaultAgentContextPaths(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): AgentContextPaths {
  const codexHome = environment.CODEX_HOME === undefined
    ? join(homedir(), '.codex')
    : resolve(environment.CODEX_HOME)
  const claudeHome = environment.CLAUDE_CONFIG_DIR === undefined
    ? join(environment.HOME ?? homedir(), '.claude')
    : resolve(environment.CLAUDE_CONFIG_DIR)
  return {
    claudeHome,
    instructionsPath: join(codexHome, 'AGENTS.md'),
    skillsRoot: join(workingDirectory, 'harlan-agent-kit', 'skills'),
  }
}

/** Loads every canonical Harlan skill, or refuses to start with partial context. */
export async function loadAgentContext(paths: AgentContextPaths): Promise<Result<AgentContext, string>> {
  const instructions = await stat(paths.instructionsPath)
    .then(metadata => ok(metadata.isFile()))
    .catch((error: unknown) => isMissingPath(error)
      ? ok(false)
      : err(`The global Agent instructions could not be read: ${errorMessage(error)}`))
  if (instructions._tag === 'Err')
    return instructions
  if (!instructions.value)
    return err(`The global Agent instructions do not exist: ${paths.instructionsPath}`)

  const entries = await readdir(paths.skillsRoot, { withFileTypes: true })
    .then(ok)
    .catch((error: unknown) => err(`The Harlan skill directory could not be read: ${errorMessage(error)}`))
  if (entries._tag === 'Err')
    return entries

  const candidates = entries.value
    .filter(entry => entry.isDirectory())
    .map(entry => join(paths.skillsRoot, entry.name))
    .sort()
  const checked = await Promise.all(candidates.map(directory => stat(join(directory, 'SKILL.md'))
    .then(metadata => ok(metadata.isFile()))
    .catch((error: unknown) => isMissingPath(error)
      ? ok(false)
      : err(`The Harlan skill could not be read: ${errorMessage(error)}`))))
  const failed = checked.find(result => result._tag === 'Err')
  if (failed?._tag === 'Err')
    return failed
  const skillDirectories = candidates.filter((_, index) => checked[index]?._tag === 'Ok' && checked[index].value)
  if (skillDirectories.length === 0)
    return err(`No Harlan skills exist under ${paths.skillsRoot}.`)

  return ok({ claudeHome: paths.claudeHome, instructionPaths: [paths.instructionsPath], skillDirectories })
}

function parseConfiguration(value: string | undefined): Result<OpencodeConfiguration, string> {
  if (value === undefined)
    return ok({})
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed)
      ? ok(parsed)
      : err('OPENCODE_CONFIG_CONTENT must contain one JSON object.')
  }
  catch {
    return err('OPENCODE_CONFIG_CONTENT must contain one JSON object.')
  }
}

function stringList(value: unknown, field: string): Result<string[], string> {
  if (value === undefined)
    return ok([])
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? ok(value)
    : err(`OPENCODE_CONFIG_CONTENT ${field} must contain only strings.`)
}

/** Adds instruction files and skill directories to an OpenCode configuration. */
function mergedConfiguration(input: {
  configuration: string | undefined
  instructionPaths: readonly string[]
  skillDirectories: readonly string[]
}): Result<string, string> {
  const parsed = parseConfiguration(input.configuration)
  if (parsed._tag === 'Err')
    return parsed
  const configuration = parsed.value
  const instructions = stringList(configuration.instructions, 'instructions')
  if (instructions._tag === 'Err')
    return instructions
  if (configuration.skills !== undefined && !isRecord(configuration.skills))
    return err('OPENCODE_CONFIG_CONTENT skills must contain one JSON object.')
  const skills = (configuration.skills ?? {}) as Record<string, unknown>
  const paths = stringList(skills.paths, 'skills.paths')
  if (paths._tag === 'Err')
    return paths

  return ok(JSON.stringify({
    ...configuration,
    instructions: unique([...instructions.value, ...input.instructionPaths]),
    skills: {
      ...skills,
      paths: unique([...paths.value, ...input.skillDirectories]),
    },
  }))
}

/** Adds the canonical context to OpenCode without dropping local configuration. */
export function opencodeAgentEnvironment(input: {
  context: AgentContext
  environment: NodeJS.ProcessEnv
}): Result<NodeJS.ProcessEnv, string> {
  const merged = mergedConfiguration({
    configuration: input.environment.OPENCODE_CONFIG_CONTENT,
    instructionPaths: input.context.instructionPaths,
    skillDirectories: input.context.skillDirectories,
  })
  if (merged._tag === 'Err')
    return merged
  return ok({
    ...input.environment,
    PATH: opencodePath(input.environment),
    OPENCODE_CONFIG_CONTENT: merged.value,
  })
}

/**
 * Adds one turn's own instruction files to the shared OpenCode environment.
 *
 * Skills are the same for every repository, so the service resolves them once.
 * Memory belongs to one repository, so only the turn that works on that
 * repository can name its index. The turn merges its own paths on top of the
 * shared configuration and changes nothing else.
 */
export function opencodeTurnEnvironment(input: {
  environment: NodeJS.ProcessEnv
  instructionPaths: readonly string[]
}): Result<NodeJS.ProcessEnv, string> {
  if (input.instructionPaths.length === 0)
    return ok(input.environment)
  const merged = mergedConfiguration({
    configuration: input.environment.OPENCODE_CONFIG_CONTENT,
    instructionPaths: input.instructionPaths,
    skillDirectories: [],
  })
  if (merged._tag === 'Err')
    return merged
  return ok({ ...input.environment, OPENCODE_CONFIG_CONTENT: merged.value })
}

/** Repository instruction files an Agent reads before it changes code. */
export const INSTRUCTION_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'] as const

/**
 * The prompt line that names the instruction files a worktree holds.
 *
 * "Read AGENTS.md" sent every Agent hunting through repositories that have
 * none. The controller checks first and says exactly what exists.
 */
export function instructionFilesLine(existing: readonly string[]): string {
  const names = INSTRUCTION_FILE_NAMES.filter(name => existing.includes(name))
  if (names.length === 0)
    return `This repository has no ${INSTRUCTION_FILE_NAMES.join(', ')}. Do not search for one.`
  return `Read these repository instruction files before you change code: ${names.join(', ')}.`
}

/** Names the instruction files that exist as regular files in one worktree. */
export async function listInstructionFiles(worktreePath: string): Promise<string[]> {
  const present = await Promise.all(INSTRUCTION_FILE_NAMES.map(name => stat(join(worktreePath, name))
    .then(metadata => metadata.isFile())
    .catch((error: unknown) => {
      if (isMissingPath(error))
        return false
      throw error
    })))
  return INSTRUCTION_FILE_NAMES.filter((_, index) => present[index])
}

/**
 * The longest project directory name Claude Code writes without a hash.
 *
 * A longer path is cut to this length and given a hash of the whole path. That
 * hash comes from Claude Code's own function, so this service cannot reproduce
 * it and refuses to guess the name.
 */
const MAXIMUM_PROJECT_SLUG_LENGTH = 200

/**
 * The directory name Claude Code gives one checkout under `projects`.
 *
 * Every character outside `a-z`, `A-Z` and `0-9` becomes one hyphen. So
 * `/home/harlan/sites/gscdump.com` becomes `-home-harlan-sites-gscdump-com`,
 * and a hidden directory doubles the hyphen.
 */
export function claudeProjectSlug(checkoutPath: string): Result<string, string> {
  if (!isAbsolute(checkoutPath))
    return err('The checkout path must be absolute.')
  const slug = checkoutPath.replace(/[^a-z0-9]/gi, '-')
  return slug.length <= MAXIMUM_PROJECT_SLUG_LENGTH
    ? ok(slug)
    : err(`A checkout path over ${MAXIMUM_PROJECT_SLUG_LENGTH} characters gets a hashed project name this service cannot reproduce.`)
}

/** The memory Harlan recorded on his desktop for one repository checkout. */
export interface RepositoryMemory {
  /** Absolute path of the index the turn loads as an instruction file. */
  indexPath: string
}

/** The path the memory index would take for one primary checkout. */
export function repositoryMemoryIndexPath(input: {
  claudeHome: string
  checkoutPath: string
}): Result<string, string> {
  const slug = claudeProjectSlug(input.checkoutPath)
  if (slug._tag === 'Err')
    return slug
  return ok(join(input.claudeHome, 'projects', slug.value, 'memory', 'MEMORY.md'))
}

/**
 * Names the memory index one repository has, or null when it has none.
 *
 * The slug must come from the primary checkout, never from the `wt` worktree a
 * turn runs in. Harlan's desktop owns memory and this service only reads it.
 * Nothing here writes under `claudeHome`.
 */
export async function findRepositoryMemory(input: {
  claudeHome: string
  checkoutPath: string
}): Promise<RepositoryMemory | null> {
  const indexPath = repositoryMemoryIndexPath(input)
  // A path too long to name has no project directory this service can find, so
  // the turn runs without memory instead of reading a wrong repository's notes.
  if (indexPath._tag === 'Err')
    return null
  return stat(indexPath.value)
    .then(metadata => metadata.isFile() ? { indexPath: indexPath.value } : null)
    .catch((error: unknown) => {
      if (isMissingPath(error))
        return null
      throw error
    })
}

/**
 * The prompt line that tells a turn what its memory index holds.
 *
 * The index reaches the model as an instruction file, and the notes stay on
 * disk. Without this line the model does not know the notes exist, nor that
 * they age. It says nothing when the repository has no memory.
 */
export function repositoryMemoryLine(memory: RepositoryMemory | null): string {
  if (memory === null)
    return ''
  return `Your instructions include the project memory index at ${memory.indexPath}.
Memory records decisions and context from earlier sessions on this repository.
Each entry links to a sibling file in the same directory by name.
Read a linked file when its entry matters to your work.
Memory records what was true when it was written.
Check it against the code before you rely on it.`
}

/**
 * The exact checks one Agent turn may run.
 *
 * Every scope is narrow, because CI owns the repository-wide result. A worker
 * picks the scope its own work defines, so the budget stays true for the turn.
 */
export const CHECK_SCOPES = {
  /** A turn that changed source files and must prove that change. */
  changedFiles: 'run the regression test file, its direct dependants, and lint and typecheck on the changed files only.',
  /** Baseline repair, where the failing CI check already names the command. */
  failingCheck: 'prefer a narrower command that reproduces the same failure; run the exact command of the failing check only when no narrower command reproduces it, then lint and typecheck on the changed files only.',
  /** Conflict resolution, where the merge already names the files in scope. */
  conflictedFiles: 'run eslint on the conflicted files, vitest on the test files that import them, and git diff --check.',
} as const

export type CheckScope = typeof CHECK_SCOPES[keyof typeof CHECK_SCOPES]

/** The check budget every Agent turn that verifies its own change gets. */
export function checkBudgetLines(scope: CheckScope): string {
  const fullSuiteRule = 'Do not run the full test suite, the full typecheck, or a build. CI runs those.'
  const lastResort = scope === CHECK_SCOPES.failingCheck
    ? ' Exception: when no narrower command reproduces the failure, run the failing check\'s exact command, even if it is the full suite.'
    : ''
  return `Check budget: ${scope}
${fullSuiteRule}${lastResort}
Failures outside the changed files are pre-existing. Do not stash changes to verify them.`
}

/** The core of the unit-tests skill, inlined so no Agent reads the file each session. */
export const UNIT_TEST_LINES = `Unit test rules:
- Write the failing test first. Confirm it fails for the stated reason.
- Test through the exported API: build an input, call the export, assert the return value, the thrown error, or a boundary side effect.
- Do not assert on file contents, module shape, key counts, or that a symbol exists.
- Delete a test that can fail while the code is correct. Delete a test that can pass while the code is broken.
- When behaviour changes on purpose, delete the old test and write the new one.
- Prefer a real fixture over a mock.`

/** Toolchain rules for every Agent turn that may run a command. */
export const TOOLCHAIN_LINES = `Use pnpm for every package command. Never use npx.
Never add debug output to tracked files.`
