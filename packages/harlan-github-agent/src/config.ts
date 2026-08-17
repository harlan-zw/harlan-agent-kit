import type { AgentProviderName } from './agent-provider.ts'
import type { AutoMergePolicy } from './auto-merge.ts'
import type { Result } from './result.ts'
import type { AgentConfig, ExternalRepositoryWatch, RepositoryMapping, RepositoryOwnership, TakeOwnershipConfig, ValidatedAgentConfig } from './types.ts'
import { execFile } from 'node:child_process'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { parse } from 'yaml'
import { err, ok } from './result.ts'

export interface ConfigIssue {
  path: string
  message: string
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseYaml(text: string): Result<unknown, ConfigIssue[]> {
  try {
    return ok(parse(text))
  }
  catch (error) {
    return err([{
      path: '$',
      message: error instanceof Error ? error.message : 'YAML parsing failed.',
    }])
  }
}

function requiredRecord(source: UnknownRecord, key: string, path: string, issues: ConfigIssue[]): UnknownRecord | undefined {
  const value = source[key]
  if (isRecord(value))
    return value

  issues.push({ path: `${path}.${key}`, message: 'Expected an object.' })
}

function requiredString(source: UnknownRecord, key: string, path: string, issues: ConfigIssue[]): string | undefined {
  const value = source[key]
  if (typeof value === 'string' && value.trim().length > 0)
    return value.trim()

  issues.push({ path: `${path}.${key}`, message: 'Expected a non-empty string.' })
}

function requiredBoolean(source: UnknownRecord, key: string, path: string, issues: ConfigIssue[]): boolean | undefined {
  const value = source[key]
  if (typeof value === 'boolean')
    return value

  issues.push({ path: `${path}.${key}`, message: 'Expected a boolean.' })
}

function fixedDate(source: UnknownRecord, key: string, path: string, issues: ConfigIssue[]): string | undefined {
  const value = source[key]
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`)
    if (!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value)
      return value
  }

  issues.push({ path: `${path}.${key}`, message: 'Expected a valid YYYY-MM-DD date.' })
}

function stringArray(source: UnknownRecord, key: string, path: string, issues: ConfigIssue[]): string[] | undefined {
  const value = source[key]
  if (Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim().length > 0))
    return value.map(item => (item as string).trim())

  issues.push({ path: `${path}.${key}`, message: 'Expected a list of non-empty strings.' })
}

/** Auto merge is off unless the configuration turns it on. */
function autoMergePolicy(source: UnknownRecord, issues: ConfigIssue[]): AutoMergePolicy | undefined {
  const value = source.auto_merge
  if (value === undefined)
    return { _tag: 'Disabled' }
  if (!isRecord(value)) {
    issues.push({ path: '$.auto_merge', message: 'Expected an object.' })
    return undefined
  }

  const enabled = requiredBoolean(value, 'enabled', '$.auto_merge', issues)
  const confidenceValue = value.minimum_confidence ?? 100
  const minimumConfidence = typeof confidenceValue === 'number' && Number.isInteger(confidenceValue) && confidenceValue >= 0 && confidenceValue <= 100
    ? confidenceValue
    : undefined
  if (minimumConfidence === undefined)
    issues.push({ path: '$.auto_merge.minimum_confidence', message: 'Expected an integer from 0 to 100.' })
  const methodValue = value.method ?? 'squash'
  const method = methodValue === 'merge' || methodValue === 'rebase' || methodValue === 'squash' ? methodValue : undefined
  if (method === undefined)
    issues.push({ path: '$.auto_merge.method', message: 'Expected merge, rebase, or squash.' })

  if (enabled === undefined || minimumConfidence === undefined || method === undefined)
    return undefined
  return enabled ? { _tag: 'Enabled', minimumConfidence, method } : { _tag: 'Disabled' }
}

function ownership(source: UnknownRecord, path: string, issues: ConfigIssue[]): RepositoryOwnership | undefined {
  const value = requiredString(source, 'ownership', path, issues)
  if (value === undefined)
    return undefined
  if (value === 'owned' || value === 'maintained' || value === 'external')
    return value

  issues.push({ path: `${path}.ownership`, message: 'Expected owned, maintained, or external.' })
}

function takeOwnership(source: UnknownRecord, path: string, repositoryOwnership: RepositoryOwnership | undefined, issues: ConfigIssue[]): TakeOwnershipConfig | undefined {
  const ownershipConfig = requiredRecord(source, 'take_ownership', path, issues)
  if (ownershipConfig === undefined)
    return undefined

  const enabled = requiredBoolean(ownershipConfig, 'enabled', `${path}.take_ownership`, issues)
  if (enabled === undefined)
    return undefined
  if (!enabled)
    return { _tag: 'Disabled' }

  const productionUrl = requiredString(ownershipConfig, 'production_url', `${path}.take_ownership`, issues)
  const requiredWorkflows = stringArray(ownershipConfig, 'required_workflows', `${path}.take_ownership`, issues)
  const smokePaths = stringArray(ownershipConfig, 'smoke_paths', `${path}.take_ownership`, issues)

  if (repositoryOwnership !== 'owned')
    issues.push({ path: `${path}.take_ownership.enabled`, message: 'Take Ownership requires an owned repository.' })
  if (productionUrl !== undefined && !productionUrl.startsWith('https://'))
    issues.push({ path: `${path}.take_ownership.production_url`, message: 'Expected an HTTPS URL.' })
  if (smokePaths?.some(smokePath => !smokePath.startsWith('/')))
    issues.push({ path: `${path}.take_ownership.smoke_paths`, message: 'Every smoke path must start with /.' })

  if (productionUrl === undefined || requiredWorkflows === undefined || smokePaths === undefined)
    return undefined

  return {
    _tag: 'Enabled',
    productionUrl,
    requiredWorkflows,
    smokePaths,
  }
}

/** Defaults to Codex, so an existing configuration keeps its current agent. */
function agentProvider(source: UnknownRecord, issues: ConfigIssue[]): AgentProviderName | undefined {
  const agent = source.agent
  if (agent === undefined)
    return 'codex'
  if (!isRecord(agent)) {
    issues.push({ path: '$.agent', message: 'Expected an object.' })
    return undefined
  }
  const provider = agent.provider
  if (provider === undefined)
    return 'codex'
  if (provider === 'codex' || provider === 'opencode')
    return provider

  issues.push({ path: '$.agent.provider', message: 'Expected codex or opencode.' })
}

function repositoryMapping(value: unknown, index: number, issues: ConfigIssue[]): RepositoryMapping | undefined {
  const path = `$.repositories[${index}]`
  if (!isRecord(value)) {
    issues.push({ path, message: 'Expected an object.' })
    return undefined
  }

  const github = requiredString(value, 'github', path, issues)
  const checkout = requiredString(value, 'checkout', path, issues)
  const enabled = requiredBoolean(value, 'enabled', path, issues)
  const repositoryOwnership = ownership(value, path, issues)
  const defaultBranch = requiredString(value, 'default_branch', path, issues)
  const writablePullRequestAuthors = stringArray(value, 'writable_pr_authors', path, issues)
  const writablePullRequestHeadPrefixes = stringArray(value, 'writable_pr_head_prefixes', path, issues)
  const issueWork = requiredBoolean(value, 'issue_work', path, issues)
  const pullRequestReview = requiredBoolean(value, 'pr_review', path, issues)
  const pullRequestConformance = requiredBoolean(value, 'pr_conformance', path, issues)
  const conflictResolution = requiredBoolean(value, 'conflict_resolution', path, issues)
  const ownershipConfig = takeOwnership(value, path, repositoryOwnership, issues)

  if (github !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(github))
    issues.push({ path: `${path}.github`, message: 'Expected owner/repository.' })
  if (checkout !== undefined && !isAbsolute(checkout))
    issues.push({ path: `${path}.checkout`, message: 'Expected an absolute path.' })
  if (defaultBranch !== undefined && !/^\w[\w./-]*$/.test(defaultBranch))
    issues.push({ path: `${path}.default_branch`, message: 'Expected a safe Git branch name.' })
  if (writablePullRequestAuthors?.length === 0)
    issues.push({ path: `${path}.writable_pr_authors`, message: 'Expected at least one author.' })
  if (writablePullRequestAuthors?.some(author => !/^[\w-]+(?:\[bot\])?$/.test(author)))
    issues.push({ path: `${path}.writable_pr_authors`, message: 'Expected GitHub login names.' })
  if (writablePullRequestHeadPrefixes?.length === 0)
    issues.push({ path: `${path}.writable_pr_head_prefixes`, message: 'Expected at least one branch prefix.' })
  if (writablePullRequestHeadPrefixes?.some(prefix => !/^\w[\w./-]*\/$/.test(prefix)))
    issues.push({ path: `${path}.writable_pr_head_prefixes`, message: 'Every branch prefix must be safe and end with /.' })
  if (conflictResolution === true && repositoryOwnership !== 'owned')
    issues.push({ path: `${path}.conflict_resolution`, message: 'Conflict resolution requires an owned repository.' })
  if (conflictResolution === true && pullRequestReview !== true)
    issues.push({ path: `${path}.conflict_resolution`, message: 'Conflict resolution requires pull request review.' })

  if (
    github === undefined
    || checkout === undefined
    || enabled === undefined
    || repositoryOwnership === undefined
    || defaultBranch === undefined
    || writablePullRequestAuthors === undefined
    || writablePullRequestHeadPrefixes === undefined
    || issueWork === undefined
    || pullRequestReview === undefined
    || pullRequestConformance === undefined
    || conflictResolution === undefined
    || ownershipConfig === undefined
  ) {
    return undefined
  }

  return {
    github,
    checkout,
    enabled,
    authentication: 'app',
    ownership: repositoryOwnership,
    defaultBranch,
    writablePullRequestAuthors,
    writablePullRequestHeadPrefixes,
    issueWork,
    pullRequestReview,
    pullRequestConformance,
    conflictResolution,
    takeOwnership: ownershipConfig,
  }
}

function externalRepositoryWatch(value: unknown, index: number, issues: ConfigIssue[]): ExternalRepositoryWatch | undefined {
  const path = `$.external_repositories[${index}]`
  if (!isRecord(value)) {
    issues.push({ path, message: 'Expected an object.' })
    return undefined
  }

  const github = requiredString(value, 'github', path, issues)
  const issueValue = value.issues
  const issueSelection = issueValue === 'all'
    ? 'all' as const
    : Array.isArray(issueValue)
      && issueValue.length > 0
      && issueValue.every(issue => typeof issue === 'number' && Number.isSafeInteger(issue) && issue > 0)
      ? [...new Set(issueValue as number[])]
      : undefined
  if (issueSelection === undefined)
    issues.push({ path: `${path}.issues`, message: 'Expected all or at least one positive issue number.' })
  if (github !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(github))
    issues.push({ path: `${path}.github`, message: 'Expected owner/repository.' })
  if (github === undefined || issueSelection === undefined)
    return undefined
  return { github, issues: issueSelection }
}

export function parseConfigText(text: string): Result<AgentConfig, ConfigIssue[]> {
  const document = parseYaml(text)
  if (document._tag === 'Err')
    return document
  if (!isRecord(document.value))
    return err([{ path: '$', message: 'Expected an object.' }])

  const issues: ConfigIssue[] = []
  const provider = agentProvider(document.value, issues)
  const github = requiredRecord(document.value, 'github', '$', issues)
  const server = requiredRecord(document.value, 'server', '$', issues)
  const storage = requiredRecord(document.value, 'storage', '$', issues)

  const appIdValue = github?.app_id
  const appId = typeof appIdValue === 'number' && Number.isSafeInteger(appIdValue) && appIdValue > 0
    ? appIdValue
    : undefined
  if (appId === undefined)
    issues.push({ path: '$.github.app_id', message: 'Expected a positive safe integer.' })
  const privateKeyPath = github === undefined ? undefined : requiredString(github, 'private_key_path', '$.github', issues)
  if (privateKeyPath !== undefined && !isAbsolute(privateKeyPath))
    issues.push({ path: '$.github.private_key_path', message: 'Expected an absolute path.' })
  const allowedOwnersValue = github?.allowed_owners
  const allowedOwners = Array.isArray(allowedOwnersValue)
    && allowedOwnersValue.length > 0
    && allowedOwnersValue.every(owner => typeof owner === 'string' && owner.trim().length > 0)
    ? allowedOwnersValue.map(owner => (owner as string).trim())
    : undefined
  if (allowedOwners === undefined)
    issues.push({ path: '$.github.allowed_owners', message: 'Expected at least one GitHub owner.' })
  if (allowedOwners?.some(owner => !/^[\w-]+$/.test(owner)))
    issues.push({ path: '$.github.allowed_owners', message: 'Expected GitHub owner names.' })
  if (allowedOwners !== undefined && new Set(allowedOwners.map(owner => owner.toLowerCase())).size !== allowedOwners.length)
    issues.push({ path: '$.github.allowed_owners', message: 'Expected unique GitHub owners.' })

  const host = server === undefined ? undefined : requiredString(server, 'host', '$.server', issues)
  const portValue = server?.port
  const port = typeof portValue === 'number' && Number.isInteger(portValue) && portValue > 0 && portValue <= 65_535
    ? portValue
    : undefined
  if (port === undefined)
    issues.push({ path: '$.server.port', message: 'Expected an integer from 1 to 65535.' })
  const allowedHost = server === undefined ? undefined : requiredString(server, 'allowed_host', '$.server', issues)
  const storagePath = storage === undefined ? undefined : requiredString(storage, 'path', '$.storage', issues)

  const pollValue = document.value.poll_interval_seconds
  const pollIntervalSeconds = typeof pollValue === 'number' && Number.isInteger(pollValue) && pollValue >= 15 && pollValue <= 3_600
    ? pollValue
    : undefined
  if (pollIntervalSeconds === undefined)
    issues.push({ path: '$.poll_interval_seconds', message: 'Expected an integer from 15 to 3600.' })
  const mutationsEnabled = typeof document.value.mutations_enabled === 'boolean'
    ? document.value.mutations_enabled
    : undefined
  if (mutationsEnabled === undefined)
    issues.push({ path: '$.mutations_enabled', message: 'Expected a boolean.' })
  const autoMerge = autoMergePolicy(document.value, issues)
  const openPullRequestsValue = document.value.max_open_pull_requests ?? 8
  const maxOpenPullRequests = typeof openPullRequestsValue === 'number' && Number.isInteger(openPullRequestsValue) && openPullRequestsValue >= 1 && openPullRequestsValue <= 100
    ? openPullRequestsValue
    : undefined
  if (maxOpenPullRequests === undefined)
    issues.push({ path: '$.max_open_pull_requests', message: 'Expected an integer from 1 to 100.' })
  const issueCutoff = fixedDate(document.value, 'issue_cutoff', '$', issues)

  const externalRepositoriesValue = document.value.external_repositories
  const externalRepositories = Array.isArray(externalRepositoriesValue)
    ? externalRepositoriesValue.map((value, index) => externalRepositoryWatch(value, index, issues)).filter(watch => watch !== undefined)
    : undefined
  if (externalRepositories === undefined)
    issues.push({ path: '$.external_repositories', message: 'Expected a list.' })
  const duplicateExternalRepositories = externalRepositories?.filter((watch, index, all) =>
    all.findIndex(candidate => candidate.github.toLowerCase() === watch.github.toLowerCase()) !== index,
  ) ?? []
  duplicateExternalRepositories.forEach(watch => issues.push({ path: '$.external_repositories', message: `Duplicate repository: ${watch.github}.` }))

  const trustedCheckoutRoots = [join(homedir(), 'pkg'), join(homedir(), 'sites')]

  const repositoriesValue = document.value.repositories
  const repositories = Array.isArray(repositoriesValue)
    ? repositoriesValue.map((value, index) => repositoryMapping(value, index, issues)).filter(mapping => mapping !== undefined)
    : undefined
  if (repositories === undefined)
    issues.push({ path: '$.repositories', message: 'Expected a list.' })

  const duplicateRepositories = repositories?.filter((mapping, index, all) =>
    all.findIndex(candidate => candidate.github.toLowerCase() === mapping.github.toLowerCase()) !== index,
  ) ?? []
  duplicateRepositories.forEach(mapping => issues.push({ path: '$.repositories', message: `Duplicate repository: ${mapping.github}.` }))

  if (host !== '127.0.0.1' && host !== '::1')
    issues.push({ path: '$.server.host', message: 'Expected a loopback address.' })
  if (allowedHost !== undefined && allowedHost !== 'harlan-github-agent.local')
    issues.push({ path: '$.server.allowed_host', message: 'Expected harlan-github-agent.local.' })
  if (storagePath !== undefined && storagePath !== ':memory:' && !isAbsolute(storagePath))
    issues.push({ path: '$.storage.path', message: 'Expected an absolute path or :memory:.' })
  if (mutationsEnabled === true && storagePath === ':memory:')
    issues.push({ path: '$.storage.path', message: 'Mutations require durable storage.' })
  const trustedStorageRoot = join(homedir(), '.local', 'share', 'harlan-github-agent')
  if (storagePath !== undefined && storagePath !== ':memory:' && !isWithin(trustedStorageRoot, storagePath))
    issues.push({ path: '$.storage.path', message: `Expected a path inside ${trustedStorageRoot}.` })

  if (
    issues.length > 0
    || provider === undefined
    || host === undefined
    || appId === undefined
    || privateKeyPath === undefined
    || allowedOwners === undefined
    || port === undefined
    || allowedHost === undefined
    || storagePath === undefined
    || pollIntervalSeconds === undefined
    || mutationsEnabled === undefined
    || autoMerge === undefined
    || maxOpenPullRequests === undefined
    || issueCutoff === undefined
    || externalRepositories === undefined
    || repositories === undefined
  ) {
    return err(issues)
  }

  return ok({
    agent: { provider },
    github: { appId, privateKeyPath, allowedOwners },
    server: { host, port, allowedHost },
    storage: { path: storagePath },
    trustedCheckoutRoots,
    mutationsEnabled,
    autoMerge,
    maxOpenPullRequests,
    pollIntervalSeconds,
    issueCutoff,
    externalRepositories,
    repositories,
  })
}

export interface RepositoryValidationDependencies {
  currentUserId: number
  getOwnerId: (path: string) => Promise<number>
  readGitCommonDirectory: (checkout: string) => Promise<string>
  resolvePath: (path: string) => Promise<string>
  readOrigin: (checkout: string) => Promise<string>
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

const defaultValidationDependencies: RepositoryValidationDependencies = {
  currentUserId: process.getuid?.() ?? -1,
  getOwnerId: path => stat(path).then(stats => stats.uid),
  readGitCommonDirectory: checkout => runGit(checkout, ['rev-parse', '--git-common-dir'])
    .then(path => resolve(checkout, path)),
  resolvePath: realpath,
  readOrigin: checkout => runGit(checkout, ['remote', 'get-url', 'origin']),
}

export function normalizeGitHubRemote(remote: string): string | undefined {
  const scpMatch = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)
  if (scpMatch?.[1] !== undefined)
    return scpMatch[1].toLowerCase()

  try {
    const url = new URL(remote)
    if (url.hostname !== 'github.com')
      return undefined
    return url.pathname.replace(/^\//, '').replace(/\.git$/, '').toLowerCase()
  }
  catch {
    return undefined
  }
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

export async function validateRepositoryMappings(config: AgentConfig, dependencies: RepositoryValidationDependencies = defaultValidationDependencies): Promise<Result<ValidatedAgentConfig, ConfigIssue[]>> {
  const resolvedRootsResult = await Promise.all(config.trustedCheckoutRoots.map(root =>
    dependencies.resolvePath(root)
      .then(path => ok(path))
      .catch(error => err(error instanceof Error ? error.message : 'Path resolution failed.')),
  ))
  const issues: ConfigIssue[] = resolvedRootsResult.flatMap((result, index) =>
    result._tag === 'Err'
      ? [{ path: `$.trusted_checkout_roots[${index}]`, message: result.error }]
      : [],
  )
  const resolvedRoots = resolvedRootsResult.flatMap(result => result._tag === 'Ok' ? [result.value] : [])
  const rootOwners = await Promise.all(resolvedRoots.map(root => dependencies.getOwnerId(root)))
  rootOwners.forEach((ownerId, index) => {
    if (ownerId !== dependencies.currentUserId)
      issues.push({ path: `$.trusted_checkout_roots[${index}]`, message: 'Trusted root has the wrong owner.' })
  })

  const mappings = await Promise.all(config.repositories.map(async (mapping, index) => {
    if (!mapping.enabled)
      return ok(mapping)

    return dependencies.resolvePath(mapping.checkout)
      .then(async (checkout) => {
        if (!resolvedRoots.some(root => isWithin(root, checkout)))
          return err<ConfigIssue>({ path: `$.repositories[${index}].checkout`, message: 'Checkout is outside every trusted root.' })

        if (await dependencies.getOwnerId(checkout) !== dependencies.currentUserId)
          return err<ConfigIssue>({ path: `$.repositories[${index}].checkout`, message: 'Checkout has the wrong owner.' })

        const gitCommonDirectory = await dependencies.resolvePath(await dependencies.readGitCommonDirectory(checkout))
        if (!isWithin(checkout, gitCommonDirectory))
          return err<ConfigIssue>({ path: `$.repositories[${index}].checkout`, message: 'Git common directory is outside the canonical checkout.' })

        const origin = await dependencies.readOrigin(checkout)
        if (normalizeGitHubRemote(origin) !== mapping.github.toLowerCase())
          return err<ConfigIssue>({ path: `$.repositories[${index}].github`, message: `Origin does not match ${mapping.github}.` })

        if (mapping.takeOwnership._tag === 'Enabled' && !resolvedRoots.some(root => root.endsWith('/sites') && isWithin(root, checkout)))
          return err<ConfigIssue>({ path: `$.repositories[${index}].take_ownership.enabled`, message: 'Take Ownership requires a checkout inside a trusted sites root.' })

        return ok({ ...mapping, checkout })
      })
      .catch(error => err<ConfigIssue>({
        path: `$.repositories[${index}].checkout`,
        message: error instanceof Error ? error.message : 'Repository validation failed.',
      }))
  }))

  mappings.forEach((result) => {
    if (result._tag === 'Err')
      issues.push(result.error)
  })
  if (issues.length > 0)
    return err(issues)

  return ok({
    ...config,
    trustedCheckoutRoots: resolvedRoots,
    repositories: mappings.flatMap(result => result._tag === 'Ok' ? [result.value] : []),
  })
}

export async function loadConfig(path: string): Promise<Result<AgentConfig, ConfigIssue[]>> {
  const linkMetadata = await lstat(path)
  if (linkMetadata.isSymbolicLink())
    return err([{ path: '$', message: 'Configuration path must not be a symbolic link.' }])
  const metadata = await stat(path)
  if (!metadata.isFile())
    return err([{ path: '$', message: 'Configuration path is not a file.' }])
  if (process.getuid !== undefined && metadata.uid !== process.getuid())
    return err([{ path: '$', message: 'Configuration file has the wrong owner.' }])
  if ((metadata.mode & 0o077) !== 0)
    return err([{ path: '$', message: 'Configuration file must use mode 0600.' }])

  return parseConfigText(await readFile(path, 'utf8'))
}

export async function loadGitHubAppPrivateKey(path: string): Promise<Result<string, ConfigIssue[]>> {
  const issuePath = '$.github.private_key_path'
  return lstat(path)
    .then(async (linkMetadata) => {
      if (linkMetadata.isSymbolicLink())
        return err([{ path: issuePath, message: 'GitHub App private key path must not be a symbolic link.' }])
      const metadata = await stat(path)
      if (!metadata.isFile())
        return err([{ path: issuePath, message: 'GitHub App private key path is not a file.' }])
      if (process.getuid !== undefined && metadata.uid !== process.getuid())
        return err([{ path: issuePath, message: 'GitHub App private key has the wrong owner.' }])
      if ((metadata.mode & 0o077) !== 0)
        return err([{ path: issuePath, message: 'GitHub App private key must use mode 0600.' }])
      const privateKey = await readFile(path, 'utf8')
      if (!/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(privateKey))
        return err([{ path: issuePath, message: 'GitHub App private key is not a PEM private key.' }])
      return ok(privateKey)
    })
    .catch((error: unknown) => err([{
      path: issuePath,
      message: error instanceof Error ? error.message : 'GitHub App private key could not be read.',
    }]))
}
