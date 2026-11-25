import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { verifyCompletion } from '../src/take-ownership-completion.ts'
import { repositoryMapping } from './fixtures.ts'

const repository = repositoryMapping({ takeOwnership: { _tag: 'Enabled', productionUrl: 'https://example.com', requiredWorkflows: ['deploy.yml'], smokePaths: ['/health'] } })
const target = { pullRequestNumber: 24, headSha: 'head', mergeSha: 'merge', mergedAt: '2026-10-05T00:00:00.000Z' }
const run = { id: 1, path: '.github/workflows/deploy.yml', source: { _tag: 'Push' as const, sha: 'merge', branch: 'main' }, status: 'completed', conclusion: 'success', url: 'https://github.com/run/1' }

it('waits for the merge workflow before making any smoke request', async () => {
  let requests = 0
  const result = await verifyCompletion(repository, target, {
    workflows: async () => ok([{ ...run, source: { _tag: 'Push', sha: 'head', branch: 'main' } }]),
    smoke: async () => {
      requests++
      return ok(new Response())
    },
  }, new AbortController().signal)
  expect(result).toEqual({ _tag: 'Pending', reason: 'Workflow deploy.yml has no delivery run for merge.' })
  expect(requests).toBe(0)
})

it('uses the newest workflow run and reports a failed delivery', async () => {
  const result = await verifyCompletion(repository, target, {
    workflows: async () => ok([run, { ...run, id: 2, conclusion: 'failure' }]),
    smoke: async () => ok(new Response()),
  }, new AbortController().signal)
  expect(result._tag).toBe('ActionRequired')
})

it('records exact workflow and smoke evidence after delivery', async () => {
  const urls: string[] = []
  const result = await verifyCompletion(repository, target, {
    workflows: async () => ok([run]),
    smoke: async (url) => {
      urls.push(url)
      return ok(new Response())
    },
  }, new AbortController().signal)
  expect(urls).toEqual(['https://example.com/health'])
  expect(result).toEqual({ _tag: 'Completed', evidence: { mergeSha: 'merge', workflows: [{ name: 'deploy.yml', url: run.url }], smoke: [{ url: urls[0], status: 200 }] } })
})

it.each([
  { revision: 'b'.repeat(40), body: '<h1>Find a guide</h1>', expected: 'Pending' },
  { revision: 'a'.repeat(40), body: '<h1>Something went wrong</h1>', expected: 'ActionRequired' },
  { revision: 'a'.repeat(40), body: '<h1>Find a guide</h1>', expected: 'Completed' },
  { revision: createHash('sha256').update('a'.repeat(40)).digest('hex'), body: '<h1>Find a guide</h1>', expected: 'Completed' },
] as const)('checks the served revision and visible content before accepting HTTP 200 ($expected)', async ({ revision, body, expected }) => {
  const mergeSha = 'a'.repeat(40)
  const checked = repositoryMapping({ takeOwnership: {
    _tag: 'Enabled',
    productionUrl: 'https://example.com',
    requiredWorkflows: ['deploy.yml'],
    smokePaths: ['/guides'],
    smokeChecks: [{ path: '/guides', assertions: [
      { _tag: 'Revision', header: 'x-release-sha' },
      { _tag: 'BodyText', text: 'Find a guide' },
    ] }],
  } })
  const requested: string[] = []
  const result = await verifyCompletion(checked, { ...target, mergeSha }, {
    workflows: async () => ok([{ ...run, source: { ...run.source, sha: mergeSha } }]),
    smoke: async (url) => {
      requested.push(url)
      return ok(new Response(body, { headers: { 'x-release-sha': revision } }))
    },
  }, new AbortController().signal)
  expect(requested).toEqual(['https://example.com/guides'])
  expect(result._tag).toBe(expected)
  if (expected === 'Completed') {
    expect(result).toMatchObject({ evidence: { smoke: [{ status: 200, assertions: [
      { _tag: 'Revision', sha: mergeSha },
      { _tag: 'BodyText' },
    ] }] } })
  }
})

it.each([
  { first: `${' '.repeat(512 * 1024)}Find a `, expected: 'Completed' },
  { first: `${' '.repeat(1024 * 1024)}Find a `, expected: 'ActionRequired' },
] as const)('checks text across response chunks within the read limit ($expected)', async ({ first, expected }) => {
  const checked = repositoryMapping({ takeOwnership: {
    _tag: 'Enabled',
    productionUrl: 'https://example.com',
    requiredWorkflows: [],
    smokePaths: [],
    smokeChecks: [{ path: '/guides', assertions: [{ _tag: 'BodyText', text: 'Find a guide' }] }],
  } })
  const encode = new TextEncoder()
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encode.encode(first))
      controller.enqueue(encode.encode('guide'))
      controller.close()
    },
  }))
  const result = await verifyCompletion(checked, target, {
    workflows: async () => ok([]),
    smoke: async () => ok(response),
  }, new AbortController().signal)
  expect(result._tag).toBe(expected)
})

it('rejects a smoke path that changes the production origin', async () => {
  let requests = 0
  const result = await verifyCompletion({ ...repository, takeOwnership: { _tag: 'Enabled', productionUrl: 'https://example.com', requiredWorkflows: [], smokePaths: ['//other.example/'] } }, target, {
    workflows: async () => ok([]),
    smoke: async () => {
      requests++
      return ok(new Response())
    },
  }, new AbortController().signal)
  expect(result._tag).toBe('ActionRequired')
  expect(requests).toBe(0)
})

it('accepts a configured workflow name and rejects an ambiguous name', async () => {
  const named = { ...repository, takeOwnership: { ...repository.takeOwnership, _tag: 'Enabled' as const, productionUrl: 'https://example.com', requiredWorkflows: ['deploy'], smokePaths: [] } }
  const source = { workflows: async () => ok([{ ...run, name: 'deploy' }]), smoke: async () => ok(new Response()) }
  expect((await verifyCompletion(named, target, source, new AbortController().signal))._tag).toBe('Completed')
  source.workflows = async () => ok([{ ...run, name: 'deploy' }, { ...run, id: 2, path: '.github/workflows/other.yml', name: 'deploy' }])
  expect((await verifyCompletion(named, target, source, new AbortController().signal))._tag).toBe('ActionRequired')
})

it('matches a downstream triggering push instead of the workflow definition commit', async () => {
  const result = await verifyCompletion(repository, target, {
    workflows: async () => ok([{ ...run, source: { _tag: 'WorkflowRun', repository: repository.github, branch: 'main', sha: target.mergeSha } }]),
    smoke: async () => ok(new Response()),
  }, new AbortController().signal)
  expect(result._tag).toBe('Completed')
})

it.each([['foreign repository', 'harlan-zw/other', 'main', 'merge'], ['foreign branch', repository.github, 'feature', 'merge'], ['different commit', repository.github, 'main', 'other']])('rejects downstream evidence for %s', async (_reason, sourceRepository, branch, sha) => {
  let requests = 0
  const result = await verifyCompletion(repository, target, {
    workflows: async () => ok([{ ...run, source: { _tag: 'WorkflowRun', repository: sourceRepository, branch, sha } }]),
    smoke: async () => {
      requests++
      return ok(new Response())
    },
  }, new AbortController().signal)
  expect(result._tag).toBe('Pending')
  expect(requests).toBe(0)
})
