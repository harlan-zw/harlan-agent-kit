import type { Octokit } from 'octokit'
import { expect, it } from 'vitest'
import { createGitHubAgentSource } from '../src/github-agent-source.ts'
import { collectJobWorkflowContext } from '../src/job-workflow-context.ts'
import { err, ok } from '../src/result.ts'
import { repositoryMapping } from './fixtures.ts'

it('supplies preparation and default working directory absent from the failed log', async () => {
  const accesses: string[] = []
  const refs: string[] = []
  const workflow = `defaults:
  run:
    working-directory: packages/site
jobs:
  test:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - name: Prepare
        run: pnpm dev:prepare
      - name: Test
        run: pnpm test
`
  const client = { rest: {
    actions: {
      getJobForWorkflowRun: async () => ({ data: { run_id: 42, name: 'test', steps: [{ name: 'Test', conclusion: 'failure' }] } }),
      downloadJobLogsForWorkflowRun: async () => ({ data: 'Missing generated imports' }),
      getWorkflowRun: async () => ({ data: { head_sha: 'a'.repeat(40), path: '.github/workflows/test.yml' } }),
    },
    repos: { getContent: async (input: { ref: string }) => {
      refs.push(input.ref)
      return { data: { type: 'file', encoding: 'base64', content: Buffer.from(workflow).toString('base64') } }
    } },
  } } as unknown as Octokit
  const source = createGitHubAgentSource({ actorLogin: () => 'bot', ownAppId: 1, createClient: () => client, tokens: {
    getToken: async (_repository, access) => {
      accesses.push(access)
      return ok({ token: 'token', expiresAt: '2026-10-08T00:00:00Z' })
    },
    invalidate: () => undefined,
  } })
  const result = await source.getFailedJobContext(repositoryMapping(), 7, new AbortController().signal)
  expect(result).toMatchObject({ _tag: 'Ok', value: {
    logTail: ['Missing generated imports'],
    workflow: { _tag: 'Available', ref: 'a'.repeat(40), job: 'test', steps: [
      { _tag: 'Action', uses: 'actions/setup-node@v4', with: { 'node-version': '24' } },
      { _tag: 'Run', name: 'Prepare', workingDirectory: 'packages/site', run: 'pnpm dev:prepare' },
      { _tag: 'Run', name: 'Test', workingDirectory: 'packages/site', run: 'pnpm test' },
    ] },
  } })
  expect(accesses).toEqual(['checks_read', 'read'])
  expect(refs).toEqual(['a'.repeat(40)])
})

it('keeps local composite preparation, shell argv, and unresolved inputs explicit', async () => {
  const reads: string[] = []
  const files: Record<string, string> = {
    '.github/workflows/test.yml': 'jobs:\n  test:\n    steps:\n      - uses: ./.github/actions/prepare\n      - run: pnpm test\n        shell: bash\n',
    // A literal GitHub expression is the untrusted input under test.
    // eslint-disable-next-line no-template-curly-in-string
    '.github/actions/prepare/action.yml': 'runs:\n  using: composite\n  steps:\n    - run: pnpm dev:prepare\n      shell: bash\n      working-directory: packages/site\n    - run: echo "${{ inputs.value }}"\n      shell: bash\n',
  }
  const result = await collectJobWorkflowContext({ path: '.github/workflows/test.yml', ref: 'a'.repeat(40), jobName: 'test', readFile: async (path) => {
    reads.push(path)
    return files[path] === undefined ? err('missing') : ok(files[path]!)
  } })
  expect(result).toMatchObject({ _tag: 'Available', steps: [
    { _tag: 'Action', steps: [
      { run: 'pnpm dev:prepare', workingDirectory: 'packages/site', invocation: { _tag: 'Declared', argvTemplate: ['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', '{script}'], script: 'pnpm dev:prepare' } },
      { invocation: { _tag: 'Unavailable', reason: 'The run command contains unresolved expressions.' } },
    ] },
    { _tag: 'Run', run: 'pnpm test' },
  ] })
  expect(reads).toEqual(['.github/workflows/test.yml', '.github/actions/prepare/action.yml'])
})

it.each([
  'jobs:\n  test:\n    strategy:\n      matrix:\n        node: [22, 24]\n    steps: []',
  'jobs:\n  test:\n    uses: ./other.yml',
  'jobs:\n  other:\n    steps: []',
  'jobs: [invalid',
  'x'.repeat(64_001),
])('reports unavailable declarations without inventing a preparation plan', async (workflow) => {
  expect(await collectJobWorkflowContext({ path: '.github/workflows/test.yml', ref: 'a'.repeat(40), jobName: 'test', readFile: async () => ok(workflow) })).toMatchObject({ _tag: 'Unavailable' })
})

it('bounds cyclic composite reads and refuses escaped directories', async () => {
  const reads: string[] = []
  const workflow = 'jobs:\n  test:\n    steps:\n      - uses: ../../other\n      - uses: ./loop\n      - run: pnpm test\n        working-directory: ../../outside\n'
  const composite = 'runs:\n  using: composite\n  steps:\n    - uses: ./loop\n'
  const result = await collectJobWorkflowContext({ path: '.github/workflows/test.yml', ref: 'a'.repeat(40), jobName: 'test', readFile: async (path) => {
    reads.push(path)
    return ok(path.endsWith('test.yml') ? workflow : composite)
  } })
  expect(result).toMatchObject({ _tag: 'Available', steps: [{ uses: '../../other' }, { uses: './loop' }, { workingDirectory: null }] })
  expect(reads).toEqual(['.github/workflows/test.yml', 'loop/action.yml', 'loop/action.yml'])
})

it('reports denied workflow reads as a limitation', async () => {
  expect(await collectJobWorkflowContext({ path: '.github/workflows/test.yml', ref: 'a'.repeat(40), jobName: 'test', readFile: async () => err('Contents read denied.') })).toEqual({ _tag: 'Unavailable', reason: 'Contents read denied.' })
})

it('preserves job logs when workflow metadata is unavailable', async () => {
  const client = { rest: { actions: {
    getJobForWorkflowRun: async () => ({ data: { run_id: 42, name: 'test', steps: [{ name: 'Test', conclusion: 'failure' }] } }),
    downloadJobLogsForWorkflowRun: async () => ({ data: 'Missing generated imports' }),
    getWorkflowRun: async () => { throw new Error('Run metadata denied.') },
  } } } as unknown as Octokit
  const source = createGitHubAgentSource({ actorLogin: () => 'bot', ownAppId: 1, createClient: () => client, tokens: {
    getToken: async () => ok({ token: 'token', expiresAt: '2026-10-08T00:00:00Z' }),
    invalidate: () => undefined,
  } })
  expect(await source.getFailedJobContext(repositoryMapping(), 7, new AbortController().signal)).toMatchObject({ _tag: 'Ok', value: {
    logTail: ['Missing generated imports'],
    workflow: { _tag: 'Unavailable', reason: 'Run metadata denied.' },
  } })
})

it('redacts named credentials in environment and action inputs', async () => {
  const workflow = 'env:\n  NODE_ENV: test\n  API_TOKEN: fake-private-value\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          token: fake-short-value\n'
  expect(await collectJobWorkflowContext({ path: '.github/workflows/test.yml', ref: 'a'.repeat(40), jobName: 'test', readFile: async () => ok(workflow) })).toMatchObject({ _tag: 'Available', steps: [
    { environment: { NODE_ENV: 'test', API_TOKEN: '[redacted]' }, with: { token: '[redacted]' } },
  ] })
})
