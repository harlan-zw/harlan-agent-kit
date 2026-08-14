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
}

interface MintTokenInput {
  installationId: number
  repositoryName: string
  permissions: Record<string, 'read' | 'write'>
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
  const now = dependencies.now ?? (() => new Date())

  const failure = <Value>(repository: string, error: unknown): Result<Value, GitHubTokenError> => {
    const status = errorStatus(error)
    return err({
      repository,
      message: error instanceof Error ? error.message : 'GitHub App authentication failed.',
      ...(status === undefined ? {} : { status }),
    })
  }

  const mint = (repository: string, access: GitHubRepositoryAccess, installationId: number): Promise<Result<GitHubRepositoryToken, GitHubTokenError>> => dependencies.mintToken({
    installationId,
    repositoryName: repositoryName(repository),
    permissions: permissions(access),
  }).then(ok).catch((error: unknown) => failure(repository, error))

  return {
    async getToken(repository, access, signal) {
      const tokenKey = `${repository.toLowerCase()}:${access}`
      const cachedToken = tokens.get(tokenKey)
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

      const token = await mint(repository, access, installationId.value)
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
          return mint(repository, access, refreshedId).then((refreshed) => {
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
    }).then((authentication) => {
      const value = authentication as { token: string, expiresAt: string }
      return { token: value.token, expiresAt: value.expiresAt }
    }),
  })
}
