import { Octokit } from 'octokit'
import { expect, it } from 'vitest'
import { createGitHubSource } from '../src/github.ts'
import { createPoller } from '../src/poller.ts'
import { ok } from '../src/result.ts'
import { repositoryMapping } from './fixtures.ts'

it('shares GitHub HTTP reads across overlapping repository observations', async () => {
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const requests: string[] = []
  const github = createGitHubSource({
    actorLogin: () => 'harlan-github-agent[bot]',
    issueCutoff: '2026-07-01',
    tokens: { getToken: async () => ok({ token: 'test', expiresAt: '2126-01-01T00:00:00Z' }), invalidate: () => {} },
    createClient: token => new Octokit({
      auth: token,
      retry: { enabled: false },
      request: { fetch: async (url: string) => {
        requests.push(new URL(url).pathname)
        if (requests.length === 1) {
          entered()
          await held
        }
        return new Response('[]', { headers: { 'content-type': 'application/json' } })
      } },
    }),
  })
  const observations: unknown[] = []
  const poller = createPoller({
    intervalMilliseconds: 60_000,
    onError: (error) => { throw error },
    poll: async (signal) => {
      const result = await github.listOpenItems(repositoryMapping(), signal)
      observations.push(result)
    },
  })
  const initial = poller.runNow()
  await started
  const deliveries = Array.from({ length: 20 }, () => poller.runNow())
  release()
  await Promise.all([initial, ...deliveries])
  await poller.stop()

  expect(requests).toHaveLength(4)
  expect(observations).toEqual([ok([]), ok([])])
  expect(requests.filter(path => path.endsWith('/issues'))).toHaveLength(2)
  expect(requests.filter(path => path.endsWith('/pulls'))).toHaveLength(2)
})
