import type { RepositoryAuthentication, RepositoryMapping } from './types.ts'
import { execFile } from 'node:child_process'
import { readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { App, Octokit } from 'octokit'
import { normalizeGitHubRemote } from './config.ts'
import { AGENT_ACTOR_LOGIN } from './review-comment.ts'

export interface InstalledRepository {
  github: string
  defaultBranch: string
  archived: boolean
  fork: boolean
  topics: string[]
  /** How the controller reached this repository: the App, or Harlan's own token. */
  authentication: RepositoryAuthentication
  owner: {
    login: string
    type: 'User' | 'Organization'
  }
}

export interface LocalCheckout {
  github: string
  checkout: string
}

export interface GitHubAppRepositoryDiscoveryOptions {
  appId: number
  allowedOwners: string[]
  privateKey: string
  userAgent?: string
}

function runGit(checkout: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-C', checkout, ...args], { encoding: 'utf8' }, (error, stdout) => {
      if (error !== null) {
        reject(error)
        return
      }
      resolve(stdout.trim())
    })
  })
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

export async function discoverLocalCheckouts(roots: string[]): Promise<LocalCheckout[]> {
  const candidates = (await Promise.all(roots.map(root => readdir(root, { withFileTypes: true })
    .then(entries => entries.filter(entry => entry.isDirectory()).map(entry => join(root, entry.name)))))).flat()

  const checkouts = await Promise.all(candidates.map(checkout => Promise.all([
    realpath(checkout),
    runGit(checkout, ['remote', 'get-url', 'origin']).then(normalizeGitHubRemote),
    runGit(checkout, ['rev-parse', '--git-common-dir']),
  ])
    .then(async ([canonicalCheckout, github, commonDirectory]) => {
      const canonicalCommonDirectory = await realpath(resolve(checkout, commonDirectory))
      return github === undefined || !isWithin(canonicalCheckout, canonicalCommonDirectory)
        ? undefined
        : { github, checkout: canonicalCheckout }
    })
    .catch(() => {
      // Immediate root children without a GitHub origin are not repository checkouts.
      return undefined
    })))

  return checkouts.flatMap(checkout => checkout === undefined ? [] : [checkout])
}

export async function discoverGitHubAppRepositories(options: GitHubAppRepositoryDiscoveryOptions): Promise<InstalledRepository[]> {
  const app = new App({
    appId: options.appId,
    privateKey: options.privateKey,
    Octokit: Octokit.defaults({ userAgent: options.userAgent ?? 'harlan-github-agent/0.0.0' }),
  })
  const repositories: InstalledRepository[] = []
  for await (const { repository } of app.eachRepository.iterator()) {
    const ownerType = repository.owner.type
    if (ownerType !== 'User' && ownerType !== 'Organization')
      continue
    if (!isAllowedRepository(repository.full_name, options.allowedOwners))
      continue
    if (repository.fork)
      continue
    repositories.push({
      github: repository.full_name,
      defaultBranch: repository.default_branch,
      archived: repository.archived,
      fork: false,
      topics: repository.topics ?? [],
      authentication: 'app',
      owner: { login: repository.owner.login, type: ownerType },
    })
  }
  return repositories
}

function defaultMapping(repository: InstalledRepository, checkout: string): RepositoryMapping {
  const ownership = repository.owner.type === 'User' ? 'owned' : 'maintained'
  return {
    github: repository.github,
    checkout,
    enabled: !repository.archived,
    authentication: repository.authentication,
    ownership,
    defaultBranch: repository.defaultBranch,
    writablePullRequestAuthors: ['harlan-zw', AGENT_ACTOR_LOGIN],
    writablePullRequestHeadPrefixes: ['fix/', 'feat/', 'chore/', 'docs/', 'refactor/', 'perf/', 'test/', 'ci/'],
    issueWork: ownership === 'owned',
    maxOpenPullRequests: null,
    prepare: { commands: [], timeoutSeconds: 600 },
    pullRequestReview: true,
    conflictResolution: ownership === 'owned',
    takeOwnership: { _tag: 'Disabled' },
  }
}

export interface UserRepositoryDiscoveryOptions {
  checkouts: LocalCheckout[]
  installed: InstalledRepository[]
  allowedOwners: string[]
  /** Reads one repository with Harlan's own token. Returns undefined when he cannot reach it. */
  readRepository: (github: string) => Promise<Omit<InstalledRepository, 'authentication'> | undefined>
}

/**
 * Decides whether the allowlist admits one repository.
 *
 * An entry is either a whole owner, `harlan-zw`, or a single repository,
 * `nuxt/scripts`. Owner-wide was once the only choice, and reaching one
 * repository in an organization meant admitting every repository in it that
 * had a local checkout. That posted ninety eight automated comments across
 * four Nuxt repositories under Harlan's own account in half an hour.
 *
 * Matching is case insensitive, because GitHub logins are.
 */
export function isAllowedRepository(github: string, allowedOwners: string[]): boolean {
  const full = github.toLowerCase()
  const owner = full.split('/')[0]
  return allowedOwners.some((entry) => {
    const allowed = entry.trim().toLowerCase()
    return allowed.includes('/') ? allowed === full : allowed === owner
  })
}

/**
 * Repositories Harlan maintains that the App cannot reach.
 *
 * An organization can refuse the App, so the controller falls back to his own
 * access: a trusted local checkout plus a repository he can read himself.
 */
export async function discoverUserRepositories(options: UserRepositoryDiscoveryOptions): Promise<InstalledRepository[]> {
  const installed = new Set(options.installed.map(repository => repository.github.toLowerCase()))
  const candidates = options.checkouts.filter(checkout =>
    isAllowedRepository(checkout.github, options.allowedOwners) && !installed.has(checkout.github.toLowerCase()))
  const unique = [...new Map(candidates.map(checkout => [checkout.github.toLowerCase(), checkout])).values()]
  const repositories = await Promise.all(unique.map(checkout => options.readRepository(checkout.github)
    .then((repository) => {
      // GitHub answers a renamed repository with its current name. A checkout that
      // still points at the old name says nothing about the repository behind it.
      if (repository === undefined || repository.github.toLowerCase() !== checkout.github.toLowerCase())
        return undefined
      return installed.has(repository.github.toLowerCase())
        ? undefined
        : { ...repository, authentication: 'user' as const }
    })
    .catch(() => {
      // An unreadable repository is one Harlan cannot reach either, so it stays untracked.
      return undefined
    })))
  return repositories.flatMap(repository => repository === undefined || repository.archived || repository.fork ? [] : [repository])
}

/**
 * Granted repositories with no trusted local checkout.
 *
 * These stay invisible to every Worker, so the service names them instead of
 * dropping them without a word.
 */
export function installedWithoutCheckout(
  repositories: InstalledRepository[],
  checkouts: LocalCheckout[],
  allowedOwners: string[],
): string[] {
  const checkoutByRepository = new Set(checkouts.map(checkout => checkout.github.toLowerCase()))
  return repositories
    .filter(repository => !repository.archived
      && !repository.fork
      && isAllowedRepository(repository.github, allowedOwners)
      && !checkoutByRepository.has(repository.github.toLowerCase()))
    .map(repository => repository.github)
    .sort((left, right) => left.localeCompare(right))
}

export function buildRepositoryMappings(
  repositories: InstalledRepository[],
  checkouts: LocalCheckout[],
  overrides: RepositoryMapping[],
  allowedOwners: string[],
): RepositoryMapping[] {
  const checkoutByRepository = new Map(checkouts.map(checkout => [checkout.github.toLowerCase(), checkout.checkout]))
  const overrideByRepository = new Map(overrides.map(mapping => [mapping.github.toLowerCase(), mapping]))

  return repositories.flatMap((repository) => {
    if (repository.fork)
      return []
    if (!isAllowedRepository(repository.github, allowedOwners))
      return []
    const checkout = checkoutByRepository.get(repository.github.toLowerCase())
    if (checkout === undefined)
      return []
    const defaults = defaultMapping(repository, checkout)
    const override = overrideByRepository.get(repository.github.toLowerCase())
    return [{
      ...defaults,
      ...override,
      github: repository.github,
      checkout,
      // How the controller reaches a repository is discovered, never declared.
      // A configuration file cannot know whether the App is installed, and one
      // that claimed an installation the organization refused sent every write
      // to a token that does not exist.
      authentication: repository.authentication,
      defaultBranch: repository.defaultBranch,
      enabled: !repository.archived && (override?.enabled ?? true),
    }]
  }).sort((left, right) => left.github.localeCompare(right.github))
}
