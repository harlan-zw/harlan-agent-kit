import { afterEach, expect, it, vi } from 'vitest'
import { createGitHubAgentSource } from '../src/github-agent-source.ts'
import { ok } from '../src/result.ts'
import { repositoryMapping, testPublicText } from './fixtures.ts'

afterEach(() => vi.unstubAllGlobals())

function setup() {
  const base = 'b'.repeat(40)
  const calls: Array<{ path: string, rendered: boolean, conditional: boolean }> = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname
    const headers = new Headers(init.headers)
    const rendered = headers.get('accept')?.includes('full+json') === true
    const conditional = headers.has('if-none-match')
    calls.push({ path, rendered, conditional })
    const respond = (response: Response) => {
      Object.defineProperty(response, 'url', { value: url })
      return response
    }
    if (conditional && !rendered)
      return respond(new Response(null, { status: 304 }))
    const data = path.endsWith('/pulls/24')
      ? {
          number: 24,
          state: 'open',
          merged_at: null,
          title: 'Fix the broken thing',
          body: '![Before](https://github.com/user-attachments/assets/a)',
          ...(rendered ? { body_html: `<img src="https://private-user-images.githubusercontent.com/a.svg?jwt=grant-${calls.length}" alt="Before">` } : {}),
          user: { login: 'harlan-zw' },
          html_url: 'https://github.com/harlan-zw/example/pull/24',
          created_at: '2026-08-01T00:00:00Z',
          updated_at: '2026-08-13T00:00:00Z',
          draft: false,
          labels: [],
          base: { sha: base, ref: 'main' },
          head: { sha: 'c'.repeat(40), ref: 'fix/thing', repo: { full_name: 'harlan-zw/example' } },
          maintainer_can_modify: true,
          mergeable: true,
        }
      : path.endsWith('/branches/main')
        ? { commit: { sha: base } }
        : path.endsWith('/check-runs')
          ? { total_count: 0, check_runs: [] }
          : path.endsWith('/actions/runs')
            ? { total_count: 0, workflow_runs: [] }
            : path.endsWith('/commits') ? [{ sha: base }] : []
    return respond(new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', 'etag': '"unchanged"' } }))
  })
  const source = createGitHubAgentSource({
    publicText: testPublicText,
    actorLogin: () => 'harlan-github-agent[bot]',
    ownAppId: 98114,
    tokens: { getToken: async () => ok({ token: 'fixture', expiresAt: '2126-01-01T00:00:00Z' }), invalidate: () => {} },
  })
  return { source, calls }
}

it('revalidates controller snapshots without requesting rendered image grants', async () => {
  const { source, calls } = setup()
  const repository = repositoryMapping()
  const signal = new AbortController().signal
  const first = await source.getPullRequestReviewSnapshot(repository, 24, signal)
  const firstCalls = calls.length
  const second = await source.getPullRequestReviewSnapshot(repository, 24, signal)

  expect(first).toEqual(ok(expect.objectContaining({ imageReferences: [] })))
  expect(first).toEqual(ok(expect.objectContaining({ checks: { _tag: 'Available', checks: [] }, baseChecks: { _tag: 'Available', checks: [] } })))
  expect(second).toEqual(first)
  expect(calls.every(call => !call.rendered)).toBe(true)
  expect(calls.slice(firstCalls).every(call => call.conditional)).toBe(true)
})

it('requests fresh image grants for each Agent snapshot, including after controller reads', async () => {
  const { source, calls } = setup()
  const repository = repositoryMapping()
  const signal = new AbortController().signal
  await source.getPullRequestReviewSnapshot(repository, 24, signal)
  const first = await source.getPullRequestReviewSnapshot(repository, 24, signal, 'rendered')
  const second = await source.getPullRequestReviewSnapshot(repository, 24, signal, 'rendered')

  expect(first._tag).toBe('Ok')
  expect(second._tag).toBe('Ok')
  if (first._tag !== 'Ok' || second._tag !== 'Ok')
    throw new Error('Expected Agent snapshots.')
  expect(first.value.imageReferences).toEqual([expect.objectContaining({ source: 'https://github.com/user-attachments/assets/a' })])
  expect(second.value.imageReferences?.[0]?.url).not.toBe(first.value.imageReferences?.[0]?.url)
  expect(calls.filter(call => call.rendered).every(call => !call.conditional)).toBe(true)
})
