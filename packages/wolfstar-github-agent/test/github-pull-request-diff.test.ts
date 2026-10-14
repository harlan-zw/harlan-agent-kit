import { describe, expect, it } from 'vitest'
import { createGitHubPullRequestDiff } from '../src/github-pull-request-diff.ts'

const base = 'a'.repeat(40)
const head = 'b'.repeat(40)
const target = { repository: 'owner/repo', number: 1, base, head }
describe('gitHub diff read authority', () => {
  it('uses read credentials for every API call and retains no upstream secrets', async () => {
    const accesses: string[] = []
    const requests: string[] = []
    const source = createGitHubPullRequestDiff({
      now: () => 0,
      log: () => {},
      tokens: {
        invalidate: () => {},
        getToken: async (_repository, access) => {
          accesses.push(access)
          return { _tag: 'Ok', value: { token: 'test-read-token', expiresAt: '2030-01-01T00:00:00Z' } }
        },
      },
      fetch: async (input, init) => {
        const url = String(input)
        requests.push(`${init?.method} ${url}`)
        expect(new Headers(init?.headers).get('authorization')).toBe('token test-read-token')
        const body = url.includes('/compare/')
          ? { merge_base_commit: { sha: base } }
          : url.includes('/files')
            ? []
            : { base: { sha: base }, head: { sha: head }, changed_files: 0 }
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
      },
    })
    expect(await source.list(target, new AbortController().signal)).toMatchObject({
      _tag: 'Ok',
      value: { files: [], coverage: { _tag: 'Complete' } },
    })
    expect(accesses).toEqual(['read', 'read', 'read', 'read'])
    expect(requests.every((request) => request.startsWith('GET https://api.github.com/repos/owner/repo/'))).toBe(true)
  })
  it('refuses credential failure without fetching or falling back', async () => {
    let fetched = false
    const source = createGitHubPullRequestDiff({
      now: () => 0,
      log: () => {},
      tokens: {
        invalidate: () => {},
        getToken: async (repository) => ({ _tag: 'Err', error: { repository, message: 'secret upstream error' } }),
      },
      fetch: async () => {
        fetched = true
        throw new Error('Unexpected request')
      },
    })
    expect(await source.list(target, new AbortController().signal)).toEqual({ _tag: 'Err', error: 'Unavailable' })
    expect(fetched).toBe(false)
  })
})
