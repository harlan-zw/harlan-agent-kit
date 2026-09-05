import type { Result } from './result.ts'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import process from 'node:process'
import { err, ok } from './result.ts'

export interface AgentContextPaths {
  instructionsPath: string
  skillsRoot: string
}

export interface AgentContext {
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
  return {
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

  return ok({ instructionPaths: [paths.instructionsPath], skillDirectories })
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

/** Adds the canonical context to OpenCode without dropping local configuration. */
export function opencodeAgentEnvironment(input: {
  context: AgentContext
  environment: NodeJS.ProcessEnv
}): Result<NodeJS.ProcessEnv, string> {
  const parsed = parseConfiguration(input.environment.OPENCODE_CONFIG_CONTENT)
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

  return ok({
    ...input.environment,
    PATH: opencodePath(input.environment),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...configuration,
      instructions: unique([...instructions.value, ...input.context.instructionPaths]),
      skills: {
        ...skills,
        paths: unique([...paths.value, ...input.context.skillDirectories]),
      },
    }),
  })
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
 * The exact checks one Agent turn may run.
 *
 * Every scope is narrow, because CI owns the repository-wide result. A worker
 * picks the scope its own work defines, so the budget stays true for the turn.
 */
export const CHECK_SCOPES = {
  /** A turn that changed source files and must prove that change. */
  changedFiles: 'run the regression test file, its direct dependants, and lint and typecheck on the changed files only.',
  /** Baseline repair, where the failing CI check already names the command. */
  failingCheck: 'run the exact command of the failing check, or a narrower command that reproduces the same failure, then lint and typecheck on the changed files only.',
  /** Conflict resolution, where the merge already names the files in scope. */
  conflictedFiles: 'run eslint on the conflicted files, vitest on the test files that import them, and git diff --check.',
} as const

export type CheckScope = typeof CHECK_SCOPES[keyof typeof CHECK_SCOPES]

/** The check budget every Agent turn that verifies its own change gets. */
export function checkBudgetLines(scope: CheckScope): string {
  return `Check budget: ${scope}
Do not run the full test suite, the full typecheck, or a build. CI runs those.
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
