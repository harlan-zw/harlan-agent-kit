import type { InstalledRepository } from './repository-discovery.ts'
import { execFile } from 'node:child_process'
import process from 'node:process'

/** Wolfstar's own GitHub access, read from his authenticated CLI. */
export interface GitHubUserAccess {
  login: () => Promise<string>
  token: (signal?: AbortSignal) => Promise<string>
  readRepository: (github: string) => Promise<Omit<InstalledRepository, 'authentication'> | undefined>
}

export interface GitHubUserAccessOptions {
  /** Runs one GitHub CLI command and returns its output. */
  run?: (args: string[], signal?: AbortSignal) => Promise<string>
}

function runGitHubCli(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      {
        encoding: 'utf8',
        env: process.env,
        ...(signal === undefined ? {} : { signal }),
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error)
          return
        }
        resolve(stdout.trim())
      },
    )
  })
}

export function createGitHubUserAccess(options: GitHubUserAccessOptions = {}): GitHubUserAccess {
  const run = options.run ?? runGitHubCli
  let cachedLogin: string | undefined

  return {
    async login() {
      cachedLogin ??= await run(['api', 'graphql', '-f', 'query={viewer{login}}', '--jq', '.data.viewer.login'])
      return cachedLogin
    },
    token: (signal) => run(['auth', 'token'], signal),
    async readRepository(github) {
      const [owner, repo] = github.split('/')
      if (owner === undefined || repo === undefined) return undefined
      return run([
        'api',
        'graphql',
        '-f',
        'query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){nameWithOwner defaultBranchRef{name} isArchived isFork repositoryTopics(first:100){nodes{topic{name}}} owner{login __typename}}}',
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${repo}`,
        '--jq',
        '.data.repository | if . == null then null else {github: .nameWithOwner, defaultBranch: (.defaultBranchRef.name // "main"), archived: .isArchived, fork: .isFork, topics: [.repositoryTopics.nodes[].topic.name], owner: {login: .owner.login, type: .owner.__typename}} end',
      ])
        .then((output) => {
          const repository = JSON.parse(output) as Omit<InstalledRepository, 'authentication'> | null
          if (repository === null) return undefined
          return repository.owner.type === 'User' || repository.owner.type === 'Organization'
            ? { ...repository, topics: repository.topics ?? [] }
            : undefined
        })
        .catch(() => {
          // No access, no repository, or no CLI: the repository stays untracked.
          return undefined
        })
    },
  }
}
