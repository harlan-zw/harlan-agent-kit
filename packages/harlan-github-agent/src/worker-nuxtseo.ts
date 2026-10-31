import type { AgentTurnRequest } from './agent-provider.ts'
import { constants } from 'node:fs'
import { access, open, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { resolveWorkerPackage } from './worker-package.ts'
import { parseEnvironmentFile } from './workspace-environment.ts'

export interface WorkerNuxtseo {
  entry: string
  packages: string[]
  links: Array<{ path: string, target: string }>
  skills: string
}

async function privateText(path: string): Promise<string | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((cause: NodeJS.ErrnoException) => {
    // A host without shared NuxtSEO configuration keeps repository credentials.
    if (cause.code === 'ENOENT')
      return undefined
    throw cause
  })
  if (file === undefined)
    return undefined
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size > 64 * 1024 || (metadata.mode & 0o077) !== 0
      || metadata.uid !== process.getuid?.() || await realpath(`/proc/self/fd/${file.fd}`) !== path) {
      throw new Error('The NuxtSEO credential source must be private, bounded, and owned by this account.')
    }
    return await file.readFile('utf8')
  }
  finally {
    await file.close()
  }
}

/** Resolve controller Routine identity without replacing durable implementation Task IDs. */
export function workerNuxtseoRoutine(input: { routineContext?: AgentTurnRequest['routineContext'], taskId?: string | undefined }): AgentTurnRequest['routineContext'] {
  if (input.routineContext !== undefined) {
    return input.routineContext.routineName === 'seo-review' || input.routineContext.routineName === 'vitals-review'
      ? input.routineContext
      : undefined
  }
  const task = /^([^:]+):(seo-review|vitals-review):/.exec(input.taskId ?? '')
  if (task === null)
    return undefined
  return { repository: task[1]!, routineName: task[2] as 'seo-review' | 'vitals-review' }
}

/** Share only the configured NuxtSEO token with explicitly selected repositories. */
export async function workerNuxtseoEnvironment(input: { configurationPath: string, repository: string | undefined, taskId: string | undefined, routineContext?: AgentTurnRequest['routineContext'] }): Promise<Record<string, string>> {
  const routine = workerNuxtseoRoutine(input)
  if (routine === undefined)
    return {}
  if (routine.repository.toLowerCase() !== input.repository?.toLowerCase())
    throw new Error('The NuxtSEO Routine repository does not match its Worktree origin.')
  const text = await privateText(input.configurationPath)
  if (text === undefined)
    return {}
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Write a NuxtSEO worker configuration object.')
  const source = value as Record<string, unknown>
  if (typeof source.environmentFile !== 'string' || !isAbsolute(source.environmentFile)
    || !Array.isArray(source.repositories) || source.repositories.length === 0
    || !source.repositories.every(repository => typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository))) {
    throw new Error('Configure an absolute NuxtSEO environment file and explicit repositories.')
  }
  if (!source.repositories.some(repository => repository.toLowerCase() === input.repository?.toLowerCase()))
    return {}
  const environment = await privateText(source.environmentFile)
  if (environment === undefined)
    throw new Error('The configured NuxtSEO environment file is missing.')
  const token = parseEnvironmentFile(environment).NUXTSEO_TOKEN
  if (!token)
    throw new Error('The configured NuxtSEO environment file has no token.')
  return { NUXTSEO_TOKEN: token }
}

/** Resolve only the installed NuxtSEO package and its declared dependency closure. */
export async function resolveWorkerNuxtseo(home: string): Promise<WorkerNuxtseo> {
  const cli = await resolveWorkerPackage(home, { name: 'nuxtseo', package: '@nuxtseo/cli', label: 'NuxtSEO' })
  if (cli === undefined)
    throw new Error('The NuxtSEO Routine requires the installed NuxtSEO CLI.')
  const skills = join(cli.root, 'skills')
  await access(join(skills, 'nuxtseo-cli/SKILL.md'), constants.R_OK)
  return { ...cli, skills }
}
