import type { GitHubTokenProvider } from './github-auth.ts'
import type { CompletionSource } from './take-ownership-completion.ts'
import { createAuthenticatedClient } from './github-auth.ts'
import { err, ok } from './result.ts'

/** Uses the mapped read credential. Smoke requests carry no GitHub credential. */
export function createCompletionSource(options: {
  tokens: GitHubTokenProvider
  fetch: typeof globalThis.fetch
  createClient?: Parameters<typeof createAuthenticatedClient>[0]['createClient']
}): CompletionSource {
  return {
    async workflows(repository, sha, signal) {
      const token = await options.tokens.getToken(repository.github, 'checks_read', signal)
      if (token._tag === 'Err')
        return err(token.error.message)
      const client = createAuthenticatedClient({ tokens: options.tokens, repository: repository.github, access: 'checks_read', token: token.value.token, signal, userAgent: 'harlan-github-agent', ...(options.createClient === undefined ? {} : { createClient: options.createClient }) })
      const [owner = '', repo = ''] = repository.github.split('/')
      return client.paginate(client.rest.actions.listWorkflowRunsForRepo, {
        owner,
        repo,
        head_sha: sha,
        event: 'push',
        branch: repository.defaultBranch,
        per_page: 100,
        request: { signal, timeout: 30_000 },
      }).then(runs => ok(runs.map(run => ({ id: run.id, name: run.name ?? null, path: run.path, sha: run.head_sha, branch: run.head_branch, event: run.event, status: run.status, conclusion: run.conclusion, url: run.html_url }))))
    },
    async smoke(url, signal) {
      // A redirect cannot prove this configured URL serves the deployed site.
      const response = await options.fetch(url, { signal, redirect: 'manual', headers: { 'user-agent': 'harlan-github-agent' } })
      await response.body?.cancel()
      return ok(response.status)
    },
  }
}
