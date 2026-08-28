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
