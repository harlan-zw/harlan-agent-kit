import type { GitHubTokenProvider } from './github-auth.ts'
import type { CompletionSource, CompletionWorkflow } from './take-ownership-completion.ts'
import { createAuthenticatedClient } from './github-auth.ts'
import { err, ok } from './result.ts'

/** Uses the mapped read credential. Smoke requests carry no GitHub credential. */
export function createCompletionSource(options: {
  tokens: GitHubTokenProvider
  fetch: typeof globalThis.fetch
  createClient?: Parameters<typeof createAuthenticatedClient>[0]['createClient']
}): CompletionSource {
  return {
    async workflows(repository, target, signal) {
      const token = await options.tokens.getToken(repository.github, 'checks_read', signal)
      if (token._tag === 'Err')
        return err(token.error.message)
      const client = createAuthenticatedClient({ tokens: options.tokens, repository: repository.github, access: 'checks_read', token: token.value.token, signal, userAgent: 'harlan-github-agent', ...(options.createClient === undefined ? {} : { createClient: options.createClient }) })
      const [owner = '', repo = ''] = repository.github.split('/')
      const request = {
        owner,
        repo,
        branch: repository.defaultBranch,
        per_page: 100,
        request: { signal, timeout: 30_000 },
      }
      const [pushes, downstream] = await Promise.all([
        client.paginate(client.rest.actions.listWorkflowRunsForRepo, { ...request, head_sha: target.mergeSha, event: 'push' }),
        // A workflow_run can start on a newer default branch commit. Its title
        // binds the triggering push, so filtering by head_sha would lose it.
        client.paginate(client.rest.actions.listWorkflowRunsForRepo, { ...request, event: 'workflow_run', created: `>=${target.mergedAt}` }),
      ])
      const workflows: CompletionWorkflow[] = []
      for (const run of [...pushes, ...downstream]) {
        let source: CompletionWorkflow['source']
        if (run.event === 'push') {
          source = { _tag: 'Push', sha: run.head_sha, branch: run.head_branch }
        }
        else if (run.event === 'workflow_run') {
          const match = / \[take_ownership:([^:\s\]]+):push:([^:\s\]]+):([a-f0-9]{40})\]$/.exec(run.display_title)
          // Missing or malformed provenance cannot satisfy delivery checks.
          if (match === null)
            continue
          source = { _tag: 'WorkflowRun', repository: match[1]!, branch: match[2]!, sha: match[3]! }
        }
        else {
          continue
        }
        workflows.push({ id: run.id, name: run.name ?? null, path: run.path, source, status: run.status, conclusion: run.conclusion, url: run.html_url })
      }
      return ok(workflows)
    },
    async smoke(url, signal) {
      // A redirect cannot prove this configured URL serves the deployed site.
      const response = await options.fetch(url, { signal, redirect: 'manual', headers: { 'user-agent': 'harlan-github-agent' } })
      await response.body?.cancel()
      return ok(response.status)
    },
  }
}
