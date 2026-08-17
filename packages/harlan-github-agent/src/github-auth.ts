import type { Result } from './result.ts'
import type { GitHubRepositoryAccess, GitHubRepositoryToken } from './types.ts'
import { App, Octokit } from 'octokit'
import { err, ok } from './result.ts'

export interface GitHubTokenError {
  repository: string
  message: string
  status?: number
}

export interface GitHubTokenProvider {
  getToken: (repository: string, access: GitHubRepositoryAccess, signal?: AbortSignal) => Promise<Result<GitHubRepositoryToken, GitHubTokenError>>
  /**
   * Forgets one cached credential.
   *
   * GitHub can answer a mint during a degraded window with a token that is
   * scoped to less than was asked for. That token then reads public
   * repositories and is rejected for private ones, and the controller used to
   * keep it for its full hour because nothing could tell the cache it was
   * wrong. A rejected request is that proof, so the caller reports it here.
   */
  invalidate: (repository: string, access: GitHubRepositoryAccess) => void
}

interface MintTokenInput {
  installationId: number
  repositoryName: string
  permissions: Record<string, 'read' | 'write'>
  /** Mints a new token instead of reading the provider's own cache. */
  refresh: boolean
}

export interface RepositoryTokenDependencies {
  getInstallationId: (repository: string, signal?: AbortSignal) => Promise<number>
  mintToken: (input: MintTokenInput) => Promise<GitHubRepositoryToken>
  now?: () => Date
}

function repositoryName(repository: string): string {
  const name = repository.split('/')[1]
  if (name === undefined || name.length === 0)
    throw new Error(`Invalid repository mapping: ${repository}.`)
  return name
}

function permissions(access: GitHubRepositoryAccess): Record<string, 'read' | 'write'> {
  if (access === 'read')
    return { contents: 'read', issues: 'read', metadata: 'read', pull_requests: 'read' }
  if (access === 'checks_read')
    return { checks: 'read', metadata: 'read', statuses: 'read' }
  if (access === 'issues_write')
    return { issues: 'write', metadata: 'read' }
  if (access === 'pull_requests_write')
    return { contents: 'read', metadata: 'read', pull_requests: 'write' }
  return { contents: 'write', metadata: 'read', workflows: 'write' }
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error))
    return undefined
  return typeof error.status === 'number' ? error.status : undefined
}

export function createRepositoryTokenProvider(dependencies: RepositoryTokenDependencies): GitHubTokenProvider {
  const installationIds = new Map<string, number>()
  const tokens = new Map<string, GitHubRepositoryToken>()
  /** Credentials a caller reported as rejected, which must never be reused. */
  const stale = new Set<string>()
  const now = dependencies.now ?? (() => new Date())

  const failure = <Value>(repository: string, error: unknown): Result<Value, GitHubTokenError> => {
    const status = errorStatus(error)
    return err({
      repository,
      message: error instanceof Error ? error.message : 'GitHub App authentication failed.',
      ...(status === undefined ? {} : { status }),
    })
  }

  const mint = (repository: string, access: GitHubRepositoryAccess, installationId: number, refresh: boolean): Promise<Result<GitHubRepositoryToken, GitHubTokenError>> => dependencies.mintToken({
    installationId,
    repositoryName: repositoryName(repository),
    permissions: permissions(access),
    refresh,
  }).then(ok).catch((error: unknown) => failure(repository, error))

  return {
    invalidate(repository, access) {
      const tokenKey = `${repository.toLowerCase()}:${access}`
      tokens.delete(tokenKey)
      installationIds.delete(repository)
      stale.add(tokenKey)
    },
    async getToken(repository, access, signal) {
      const tokenKey = `${repository.toLowerCase()}:${access}`
      const refresh = stale.delete(tokenKey)
      const cachedToken = refresh ? undefined : tokens.get(tokenKey)
      if (cachedToken !== undefined && Date.parse(cachedToken.expiresAt) - now().getTime() > 60_000)
        return ok(cachedToken)

      const cached = installationIds.get(repository)
      const installationId = await Promise.resolve(cached)
        .then(id => id ?? dependencies.getInstallationId(repository, signal).then((resolved) => {
          installationIds.set(repository, resolved)
          return resolved
        }))
        .then((value): Result<number, GitHubTokenError> => ok(value))
        .catch((error: unknown): Result<number, GitHubTokenError> => failure(repository, error))
      if (installationId._tag === 'Err')
        return installationId

      const token = await mint(repository, access, installationId.value, refresh)
      if (token._tag === 'Ok') {
        tokens.set(tokenKey, token.value)
        return token
      }
      if (cached === undefined || (token.error.status !== 401 && token.error.status !== 404))
        return token

      tokens.delete(tokenKey)
      installationIds.delete(repository)
      return dependencies.getInstallationId(repository, signal)
        .then((refreshedId) => {
          installationIds.set(repository, refreshedId)
          return mint(repository, access, refreshedId, true).then((refreshed) => {
            if (refreshed._tag === 'Ok')
              tokens.set(tokenKey, refreshed.value)
            return refreshed
          })
        })
        .catch((error: unknown) => failure(repository, error))
    },
  }
}

export interface GitHubAppTokenProviderOptions {
  appId: number
  privateKey: string
  userAgent?: string
}

export function createGitHubAppTokenProvider(options: GitHubAppTokenProviderOptions): GitHubTokenProvider {
  const app = new App({
    appId: options.appId,
    privateKey: options.privateKey,
    Octokit: Octokit.defaults({ userAgent: options.userAgent ?? 'harlan-github-agent/0.0.0' }),
  })

  return createRepositoryTokenProvider({
    getInstallationId: async (repository, signal) => {
      const [owner, repo] = repository.split('/')
      if (owner === undefined || repo === undefined)
        throw new Error(`Invalid repository mapping: ${repository}.`)
      const response = await app.octokit.rest.apps.getRepoInstallation({
        owner,
        repo,
        ...(signal === undefined ? {} : { request: { signal } }),
      })
      return response.data.id
    },
    mintToken: async input => app.octokit.auth({
      type: 'installation',
      installationId: input.installationId,
      repositoryNames: [input.repositoryName],
      permissions: input.permissions,
      // Octokit keeps its own token cache for a whole hour, so a refresh has to
      // reach past it or the caller is handed back the credential it rejected.
      ...(input.refresh ? { refresh: true } : {}),
    }).then((authentication) => {
      const value = authentication as { token: string, expiresAt: string }
      return { token: value.token, expiresAt: value.expiresAt }
    }),
  })
}

export interface UserTokenProviderOptions {
  /** Reads Harlan's own GitHub token, normally from the authenticated CLI. */
  readToken: (signal?: AbortSignal) => Promise<string>
  now?: () => Date
  /** How long one read is reused before the token is read again. */
  cacheMilliseconds?: number
}

/**
 * Authenticates as Harlan for a repository in an organization that cannot
 * install the App. The token is his own, so it carries his access and no more.
 */
export function createUserTokenProvider(options: UserTokenProviderOptions): GitHubTokenProvider {
  const now = options.now ?? (() => new Date())
  const cacheMilliseconds = options.cacheMilliseconds ?? 5 * 60_000
  let cached: GitHubRepositoryToken | undefined

  return {
    invalidate() {
      cached = undefined
    },
    async getToken(repository, _access, signal) {
      if (cached !== undefined && Date.parse(cached.expiresAt) - now().getTime() > 30_000)
        return ok(cached)
      return options.readToken(signal)
        .then((token): Result<GitHubRepositoryToken, GitHubTokenError> => {
          if (token.trim().length === 0)
            return err({ repository, message: 'The GitHub CLI returned no token.' })
          cached = { token: token.trim(), expiresAt: new Date(now().getTime() + cacheMilliseconds).toISOString() }
          return ok(cached)
        })
        .catch((error: unknown) => err({
          repository,
          message: error instanceof Error ? error.message : 'The GitHub CLI token could not be read.',
        }))
    },
  }
}

export interface RoutedTokenProviderOptions {
  app: GitHubTokenProvider
  user: GitHubTokenProvider
  /** True for repositories the App cannot reach. */
  usesUserToken: (repository: string) => boolean
}

export function createRoutedTokenProvider(options: RoutedTokenProviderOptions): GitHubTokenProvider {
  const provider = (repository: string): GitHubTokenProvider => options.usesUserToken(repository) ? options.user : options.app
  return {
    getToken: (repository, access, signal) => provider(repository).getToken(repository, access, signal),
    invalidate: (repository, access) => provider(repository).invalidate(repository, access),
  }
}

/** GitHub rejects a request this way when the credential does not carry the access. */
export function isAuthenticationRejection(status: number | undefined): boolean {
  return status === 401 || status === 403
}

export interface AuthenticatedClientOptions {
  tokens: GitHubTokenProvider
  repository: string
  access: GitHubRepositoryAccess
  token: string
  userAgent: string
  signal?: AbortSignal | undefined
  /** Injected for tests. Receives the same options the real client is built with. */
  createClient?: (options: { authStrategy: () => unknown, auth: unknown, userAgent: string }) => Octokit
}

/**
 * Reads the credential at request time instead of closing over one value.
 *
 * Octokit applies its authentication last, so a retry that only rewrites the
 * request header is overwritten by the original token on the way out.
 */
function mutableTokenStrategy(credential: { token: string }) {
  return () => ({
    type: 'token' as const,
    async hook(request: { endpoint: { merge: (route: unknown, parameters: unknown) => { headers: Record<string, string> } } } & ((endpoint: unknown) => Promise<unknown>), route: unknown, parameters: unknown) {
      const endpoint = request.endpoint.merge(route, parameters)
      endpoint.headers.authorization = `token ${credential.token}`
      return request(endpoint)
    },
  })
}

/**
 * One GitHub client that gives a rejected credential exactly one more chance.
 *
 * The retry mints a fresh token instead of reusing the cached one, so a
 * credential GitHub answered wrongly costs one extra request rather than an
 * hour of rejected reads. One retry per client is enough: a second rejection
 * describes the installation, not the token, and belongs in an Incident.
 */
export function createAuthenticatedClient(options: AuthenticatedClientOptions): Octokit {
  const credential = { token: options.token }
  const clientOptions = {
    authStrategy: mutableTokenStrategy(credential),
    auth: credential,
    userAgent: options.userAgent,
  }
  const octokit = options.createClient === undefined
    ? new Octokit(clientOptions as never)
    : options.createClient(clientOptions)
  let retried = false

  octokit.hook.wrap('request', async (request, requestOptions) => {
    try {
      return await request(requestOptions)
    }
    catch (error) {
      if (retried || !isAuthenticationRejection(errorStatus(error)))
        throw error
      retried = true
      options.tokens.invalidate(options.repository, options.access)
      const refreshed = await options.tokens.getToken(options.repository, options.access, options.signal)
      if (refreshed._tag === 'Err')
        throw error
      credential.token = refreshed.value.token
      return await request(requestOptions)
    }
  })
  return octokit
}
