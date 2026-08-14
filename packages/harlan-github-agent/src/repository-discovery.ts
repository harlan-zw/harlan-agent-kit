import type { RepositoryMapping } from './types.ts'
import { execFile } from 'node:child_process'
import { readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { App, Octokit } from 'octokit'
import { normalizeGitHubRemote } from './config.ts'

export interface InstalledRepository {
  github: string
  defaultBranch: string
  archived: boolean
  topics: string[]
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
  const allowedOwners = new Set(options.allowedOwners.map(owner => owner.toLowerCase()))
  for await (const { repository } of app.eachRepository.iterator()) {
    const ownerType = repository.owner.type
    if (ownerType !== 'User' && ownerType !== 'Organization')
      continue
    if (!allowedOwners.has(repository.owner.login.toLowerCase()))
      continue
    repositories.push({
      github: repository.full_name,
      defaultBranch: repository.default_branch,
      archived: repository.archived,
      topics: repository.topics ?? [],
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
    ownership,
    defaultBranch: repository.defaultBranch,
    writablePullRequestAuthors: ['harlan-zw'],
    writablePullRequestHeadPrefixes: ['fix/', 'feat/', 'chore/', 'docs/', 'refactor/', 'perf/', 'test/'],
    issueWork: ownership === 'owned',
    pullRequestReview: true,
    pullRequestConformance: true,
    conflictResolution: ownership === 'owned',
    takeOwnership: { _tag: 'Disabled' },
  }
}

export function buildRepositoryMappings(
  repositories: InstalledRepository[],
  checkouts: LocalCheckout[],
  overrides: RepositoryMapping[],
  allowedOwners: string[],
): RepositoryMapping[] {
  const checkoutByRepository = new Map(checkouts.map(checkout => [checkout.github.toLowerCase(), checkout.checkout]))
  const overrideByRepository = new Map(overrides.map(mapping => [mapping.github.toLowerCase(), mapping]))
  const allowedOwnerSet = new Set(allowedOwners.map(owner => owner.toLowerCase()))

  return repositories.flatMap((repository) => {
    if (!allowedOwnerSet.has(repository.owner.login.toLowerCase()))
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
      defaultBranch: repository.defaultBranch,
      enabled: !repository.archived && (override?.enabled ?? true),
    }]
  }).sort((left, right) => left.github.localeCompare(right.github))
}
