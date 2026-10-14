import type { GitHubTokenProvider } from './github-auth.ts'
import { Octokit } from 'octokit'
import { createAuthenticatedClient } from './github-auth.ts'
import { createPullRequestDiffSource } from './pull-request-diff.ts'

/** The diff boundary carries read authority and limits each GitHub response before parsing JSON. */
export function createGitHubPullRequestDiff(options: {
  tokens: GitHubTokenProvider
  now: () => number
  log: (message: string) => void
  fetch?: typeof globalThis.fetch
}) {
  const fetch = options.fetch ?? globalThis.fetch
  const boundedFetch: typeof globalThis.fetch = async (input, init) => {
    const timeout = AbortSignal.timeout(10000)
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    const response = await fetch(input, { ...init, signal, redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new Error('GitHub redirected the diff request.')
    }
    if (!response.body) return response
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > 8 * 1024 * 1024) throw new Error('GitHub diff response exceeds the limit.')
        chunks.push(chunk.value)
      }
      return new Response(Buffer.concat(chunks), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } finally {
      await reader.cancel().catch(() => {
        // Cancellation can race completed upstream reads. The response has already been handled.
      })
      reader.releaseLock()
    }
  }
  return createPullRequestDiffSource({
    now: options.now,
    log: options.log,
    read: async (repository, route, parameters, signal) => {
      const token = await options.tokens.getToken(repository, 'read', signal)
      if (token._tag === 'Err') throw new Error('GitHub read authority is unavailable.')
      const client = createAuthenticatedClient({
        access: 'read',
        repository,
        tokens: options.tokens,
        token: token.value.token,
        userAgent: 'wolfstar-github-agent',
        signal,
        createClient: (options) =>
          new Octokit({ ...options, request: { fetch: boundedFetch } } as ConstructorParameters<typeof Octokit>[0]),
      })
      return client.request(route, { ...parameters, request: { signal } }).then((response) => response.data)
    },
  })
}
