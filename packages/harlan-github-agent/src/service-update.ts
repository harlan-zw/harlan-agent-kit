import type { Result } from './result.ts'
import type { ServiceUpdateStatus } from './types.ts'
import { execFile, execFileSync } from 'node:child_process'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { err, ok } from './result.ts'

const DEFAULT_CHECK_INTERVAL_MILLISECONDS = 5 * 60_000
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const execFileAsync = promisify(execFile)

export interface ServiceUpdateSource {
  read: () => ServiceUpdateStatus
  refresh: () => Promise<void>
  prepare: (targetCommit: string) => Promise<Result<void, string>>
  start: () => void
  stop: () => Promise<void>
}

export function createServiceUpdateSource(options: {
  deployedCommit: string
  now: () => Date
  readLatestCommit: () => Promise<string>
  prepareCommit: (targetCommit: string) => Promise<Result<void, string>>
  onError: (error: unknown) => void
  checkIntervalMilliseconds?: number
}): ServiceUpdateSource {
  let status: ServiceUpdateStatus = { _tag: 'Checking', deployedCommit: options.deployedCommit }
  let interval: ReturnType<typeof setInterval> | undefined
  let refreshPromise: Promise<void> | undefined

  const refresh = (): Promise<void> => {
    if (refreshPromise !== undefined)
      return refreshPromise
    refreshPromise = options.readLatestCommit()
      .then((latestCommit) => {
        const checkedAt = options.now().toISOString()
        status = latestCommit === options.deployedCommit
          ? { _tag: 'Current', deployedCommit: options.deployedCommit, latestCommit, checkedAt }
          : { _tag: 'Available', deployedCommit: options.deployedCommit, latestCommit, checkedAt }
      })
      .catch((error: unknown) => {
        options.onError(error)
        status = {
          _tag: 'Unavailable',
          deployedCommit: options.deployedCommit,
          checkedAt: options.now().toISOString(),
          reason: 'The latest commit could not be checked. Retry later.',
        }
      })
      .finally(() => {
        refreshPromise = undefined
      })
    return refreshPromise
  }

  return {
    read: () => status,
    refresh,
    prepare: targetCommit => COMMIT_PATTERN.test(targetCommit)
      ? options.prepareCommit(targetCommit)
      : Promise.resolve(err('The update request has an invalid target commit.')),
    start: () => {
      if (interval !== undefined)
        return
      void refresh()
      interval = setInterval(() => void refresh(), options.checkIntervalMilliseconds ?? DEFAULT_CHECK_INTERVAL_MILLISECONDS)
      interval.unref()
    },
    stop: () => {
      if (interval !== undefined) {
        clearInterval(interval)
        interval = undefined
      }
      return refreshPromise ?? Promise.resolve()
    },
  }
}

function readDeployedCommit(repositoryRoot: string): string {
  const commit = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (!COMMIT_PATTERN.test(commit))
    throw new Error('The deployed Git commit is invalid.')
  return commit
}

async function readLatestCommit(repositoryRoot: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repositoryRoot, 'ls-remote', 'origin', 'refs/heads/main'], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  const [commit, ref, extra] = stdout.trim().split(/\s+/)
  if (!COMMIT_PATTERN.test(commit ?? '') || ref !== 'refs/heads/main' || extra !== undefined)
    throw new Error('origin/main did not resolve to one Git commit.')
  return commit!
}

export function createGitServiceUpdateSource(options: {
  repositoryRoot: string
  now: () => Date
  onError: (error: unknown) => void
}): ServiceUpdateSource {
  const repositoryRoot = execFileSync('git', ['-C', options.repositoryRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  return createServiceUpdateSource({
    deployedCommit: readDeployedCommit(repositoryRoot),
    now: options.now,
    readLatestCommit: () => readLatestCommit(repositoryRoot),
    prepareCommit: async (targetCommit) => {
      return execFileAsync('bash', [join(repositoryRoot, 'scripts/service.sh'), 'prepare-update', targetCommit], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...process.env, HARLAN_GITHUB_AGENT_CHECKOUT: repositoryRoot },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 15 * 60_000,
      }).then(
        () => ok(undefined),
        (error: unknown) => {
          options.onError(error)
          return err('The update could not be prepared. Check the service log.')
        },
      )
    },
    onError: options.onError,
  })
}
