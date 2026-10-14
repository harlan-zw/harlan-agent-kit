import type { GitHubTokenProvider } from './github-auth.ts'
import type { GitHubAccount } from './types.ts'
import { lstat, readFile } from 'node:fs/promises'
import { Octokit } from 'octokit'
import { err, ok } from './result.ts'

/** Read controller credentials without following symlinks or exposing their contents. */
export async function readGitHubAccountToken(account: GitHubAccount): Promise<string> {
  const metadata = await lstat(account.tokenPath)
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && metadata.uid !== process.getuid())
  ) {
    throw new Error('The GitHub account token needs an owned regular file with mode 0600.')
  }
  const token = (await readFile(account.tokenPath, 'utf8')).trim()
  if (token.length < 32) throw new Error('The GitHub account token is incomplete.')
  return token
}

export async function readGitHubAccountLogin(token: string, signal?: AbortSignal): Promise<string> {
  const client = new Octokit({ auth: token })
  const response = await client.rest.users.getAuthenticated(signal === undefined ? {} : { request: { signal } })
  return response.data.login
}

/** An explicit account owns its route, including failed authentication. */
export function createGitHubAccountTokenProvider(options: {
  fallback: GitHubTokenProvider
  account: (repository: string) => GitHubAccount | undefined
  readToken: (account: GitHubAccount) => Promise<string>
  readLogin: (token: string, signal?: AbortSignal) => Promise<string>
  now: () => Date
}): GitHubTokenProvider {
  const verified = new Map<string, { token: string; expiresAt: string }>()
  return {
    invalidate(repository, access) {
      if (options.account(repository) === undefined) options.fallback.invalidate(repository, access)
      else verified.delete(repository.toLowerCase())
    },
    rateLimited(repository, limit) {
      if (options.account(repository) === undefined) options.fallback.rateLimited?.(repository, limit)
    },
    async getToken(repository, access, signal) {
      const account = options.account(repository)
      if (account === undefined) return options.fallback.getToken(repository, access, signal)
      const key = repository.toLowerCase()
      const cached = verified.get(key)
      if (cached !== undefined && Date.parse(cached.expiresAt) > options.now().getTime()) return ok(cached)
      return options
        .readToken(account)
        .then(async (token) => {
          const login = await options.readLogin(token, signal)
          if (login.toLowerCase() !== account.login.toLowerCase())
            return err({ repository, message: `The controller credential does not belong to @${account.login}.` })
          const credential = { token, expiresAt: new Date(options.now().getTime() + 5 * 60_000).toISOString() }
          verified.set(key, credential)
          return ok(credential)
        })
        .catch(() =>
          err({ repository, message: `The controller credential for @${account.login} could not be verified.` }),
        )
    },
  }
}

/** Replace automated attribution only. Evidence and commands retain their original text. */
export function githubAccountBody(body: string, account?: GitHubAccount): string {
  if (account === undefined) return body
  const link = `[${account.name}](${account.url})`
  let fence: string | undefined
  return body
    .split('\n')
    .map((line) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
      if (marker !== null) {
        if (fence === undefined) fence = marker[1]!
        else if (
          marker[1]![0] === fence[0] &&
          marker[1]!.length >= fence.length &&
          line.slice(marker[0].length).trim() === ''
        )
          fence = undefined
        return line
      }
      if (fence !== undefined || !line.startsWith('> ')) return line
      if (
        /^> (?:🤖 AI disclosure: )?\[Wolfstar Agent Kit\]\(https:\/\/github.com\/wolfstar-project\/wolfstar-agent-kit\)/.test(
          line,
        )
      ) {
        return line
          .replace('[Wolfstar Agent Kit](https://github.com/wolfstar-project/wolfstar-agent-kit)', link)
          .replace(/It is not Wolfstar's personal (?:review or approval|assessment or commitment)\. ?/, '')
      }
      return line
        .replace(
          "> The Wolfstar Agent Kit opened this issue automatically. It is not Wolfstar's own report.",
          `> ${link} opened this issue automatically.`,
        )
        .replace('> Wolfstar Agent Kit wrote this automated report.', `> ${link} wrote this automated report.`)
    })
    .join('\n')
}

export function githubAccountInstructions(account?: GitHubAccount): string {
  return account === undefined
    ? ''
    : `\nAutomated GitHub writing instructions for ${account.name}:\n${account.instructions}\nKeep evidence, technical terms, decisions, and required actions exact. Keep the response schema unchanged.\n`
}
