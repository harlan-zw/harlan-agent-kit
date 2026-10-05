import { expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { verifyCompletion } from '../src/take-ownership-completion.ts'
import { repositoryMapping } from './fixtures.ts'

const repository = repositoryMapping({ takeOwnership: { _tag: 'Enabled', productionUrl: 'https://example.com', requiredWorkflows: ['deploy.yml'], smokePaths: ['/health'] } })
const target = { pullRequestNumber: 24, headSha: 'head', mergeSha: 'merge', mergedAt: '2026-10-05T00:00:00.000Z' }
const run = { id: 1, path: '.github/workflows/deploy.yml', sha: 'merge', branch: 'main', event: 'push', status: 'completed', conclusion: 'success', url: 'https://github.com/run/1' }

it('waits for the merge workflow before making any smoke request', async () => {
  let requests = 0
  const result = await verifyCompletion(repository, target, {
    workflows: async () => ok([{ ...run, sha: 'head', event: 'pull_request' }]),
    smoke: async () => {
      requests++
      return ok(200)
    },
  }, new AbortController().signal)
  expect(result).toEqual({ _tag: 'Pending', reason: 'Workflow deploy.yml has no default branch push run for merge.' })
  expect(requests).toBe(0)
})

it('uses the newest workflow run and reports a failed delivery', async () => {
  const result = await verifyCompletion(repository, target, {
    workflows: async () => ok([run, { ...run, id: 2, conclusion: 'failure' }]),
    smoke: async () => ok(200),
  }, new AbortController().signal)
  expect(result._tag).toBe('ActionRequired')
})

it('records exact workflow and smoke evidence after delivery', async () => {
  const urls: string[] = []
  const result = await verifyCompletion(repository, target, {
    workflows: async () => ok([run]),
    smoke: async (url) => {
      urls.push(url)
      return ok(200)
    },
  }, new AbortController().signal)
  expect(urls).toEqual(['https://example.com/health'])
  expect(result).toEqual({ _tag: 'Completed', evidence: { mergeSha: 'merge', workflows: [{ name: 'deploy.yml', url: run.url }], smoke: [{ url: urls[0], status: 200 }] } })
})

it('rejects a smoke path that changes the production origin', async () => {
  let requests = 0
  const result = await verifyCompletion({ ...repository, takeOwnership: { _tag: 'Enabled', productionUrl: 'https://example.com', requiredWorkflows: [], smokePaths: ['//other.example/'] } }, target, {
    workflows: async () => ok([]),
    smoke: async () => {
      requests++
      return ok(200)
    },
  }, new AbortController().signal)
  expect(result._tag).toBe('ActionRequired')
  expect(requests).toBe(0)
})

it('accepts a configured workflow name and rejects an ambiguous name', async () => {
  const named = { ...repository, takeOwnership: { ...repository.takeOwnership, _tag: 'Enabled' as const, productionUrl: 'https://example.com', requiredWorkflows: ['deploy'], smokePaths: [] } }
  const source = { workflows: async () => ok([{ ...run, name: 'deploy' }]), smoke: async () => ok(200) }
  expect((await verifyCompletion(named, target, source, new AbortController().signal))._tag).toBe('Completed')
  source.workflows = async () => ok([{ ...run, name: 'deploy' }, { ...run, id: 2, path: '.github/workflows/other.yml', name: 'deploy' }])
  expect((await verifyCompletion(named, target, source, new AbortController().signal))._tag).toBe('ActionRequired')
})
