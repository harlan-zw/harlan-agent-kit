import { Octokit } from 'octokit'
import { describe, expect, it } from 'vitest'
import { err, ok } from '../src/result.ts'
import { collectRepairGitHubEvidence, collectRoutineGitHubEvidence, createRoutineGitHubEvidenceSource, jobExecutionContext } from '../src/worker-github-evidence.ts'
import { repositoryMapping } from './fixtures.ts'

it('collects bounded open ownership using only the controller read grant', async () => {
  const paths: string[] = []
  const accesses: string[] = []
  const source = createRoutineGitHubEvidenceSource({
    tokens: { getToken: async (_repository, access) => {
      accesses.push(access)
      return ok({ token: 'controller-secret', expiresAt: '2126-01-01T00:00:00Z' })
    }, invalidate: () => undefined },
    now: () => new Date('2026-11-01T07:00:00Z'),
    jobs: { getFailedJobContext: async () => { throw new Error('Ownership must not read job logs.') } },
    createClient: options => new Octokit({ ...options, request: { fetch: async (url: string, init: RequestInit) => {
      const parsed = new URL(url)
      paths.push(parsed.pathname + parsed.search)
      expect((init.headers as Record<string, string>).authorization).toBe('token controller-secret')
      if (parsed.pathname.endsWith('/pulls'))
        return Response.json({ message: 'Private pull request evidence unavailable.' }, { status: 404 })
      return Response.json(Array.from({ length: 21 }, (_, index) => ({
        number: index + 1,
        title: index === 0 ? 'a'.repeat(501) : 'Related work',
        body: index === 0 ? `Untrusted owner note. ghp_12345678901234567890 ${'b'.repeat(3000)}` : null,
      })))
    } } } as never),
  })
  const result = await source.collectOwnership(repositoryMapping(), new AbortController().signal)
  expect(paths.sort()).toEqual([
    '/repos/harlan-zw/example/issues?state=open&per_page=21',
    '/repos/harlan-zw/example/pulls?state=open&per_page=21',
  ])
  expect(accesses).toEqual(['read'])
  expect(result.issues).toMatchObject({ _tag: 'Available', truncated: true, entries: [{ number: 1, title: 'a'.repeat(500) }, ...Array.from({ length: 19 }, (_, index) => ({ number: index + 2 }))] })
  expect(result.pullRequests).toMatchObject({ _tag: 'Unavailable' })
  expect(result.ownership.issues).toMatchObject({ _tag: 'Available', truncated: true, entries: [{ number: 1, body: { _tag: 'Truncated' } }, ...Array.from({ length: 19 }, (_, index) => ({ number: index + 2 }))] })
  expect(result.ownership.pullRequests).toMatchObject({ _tag: 'Unavailable' })
  expect(JSON.stringify(result)).not.toContain('controller-secret')
  expect(JSON.stringify(result)).not.toContain('ghp_12345678901234567890')
})

it('keeps empty successful ownership separate from unavailable private reads', async () => {
  const source = createRoutineGitHubEvidenceSource({
    tokens: { getToken: async () => ok({ token: 'controller-secret', expiresAt: '2126-01-01T00:00:00Z' }), invalidate: () => undefined },
    now: () => new Date('2026-11-01T07:00:00Z'),
    jobs: { getFailedJobContext: async () => { throw new Error('Ownership must not read job logs.') } },
    createClient: options => new Octokit({ ...options, request: { fetch: async () => Response.json([]) } } as never),
  })
  const result = await source.collectOwnership(repositoryMapping(), new AbortController().signal)
  expect(result).toEqual({
    observedAt: '2026-11-01T07:00:00.000Z',
    issues: { _tag: 'Available', entries: [], truncated: false },
    pullRequests: { _tag: 'Available', entries: [], truncated: false },
    ownership: {
      _tag: 'Available',
      issues: { _tag: 'Available', entries: [], truncated: false },
      pullRequests: { _tag: 'Available', entries: [], truncated: false },
    },
  })
})

it('supplies redacted ownership bodies without another GitHub request', async () => {
  const paths: string[] = []
  const result = await collectRoutineGitHubEvidence({
    repository: 'harlan-zw/example',
    evidenceScope: 'ownership',
    now: () => new Date('2026-10-31T06:00:00Z'),
    read: async (path) => {
      paths.push(path)
      if (path.includes('/issues?')) {
        return ok([
          { number: 3, title: 'Shared first paint', body: 'Shared bundle already tracked. ghp_12345678901234567890' },
          { number: 4, title: 'A pull request', body: 'Not an issue', pull_request: {} },
        ])
      }
      if (path.includes('/pulls?'))
        return ok([{ number: 7, title: 'Bound the bundle', body: 'Repairs the shared bundle on the tools routes.' }])
      return ok(path.includes('/actions/runs?') ? { workflow_runs: [] } : [])
    },
  })
  expect(paths.sort()).toEqual([
    '/repos/harlan-zw/example/actions/runs?per_page=21',
    '/repos/harlan-zw/example/deployments?per_page=21',
    '/repos/harlan-zw/example/issues?state=open&per_page=21',
    '/repos/harlan-zw/example/pulls?state=open&per_page=21',
  ])
  expect(result.ownership).toMatchObject({
    _tag: 'Available',
    issues: { _tag: 'Available', entries: [{ number: 3, body: { _tag: 'Complete', text: expect.stringContaining('Shared bundle already tracked.') } }], truncated: false },
    pullRequests: { _tag: 'Available', entries: [{ number: 7, body: { _tag: 'Complete', text: 'Repairs the shared bundle on the tools routes.' } }], truncated: false },
  })
  expect(JSON.stringify(result)).not.toContain('ghp_12345678901234567890')
})

it('distinguishes missing bodies, truncated bodies, and incomplete ownership lists', async () => {
  const result = await collectRoutineGitHubEvidence({
    repository: 'harlan-zw/example',
    evidenceScope: 'ownership',
    now: () => new Date('2026-10-31T06:00:00Z'),
    read: async path => path.includes('/issues?')
      ? ok(Array.from({ length: 21 }, (_, index) => ({ number: index + 1, body: index === 0 ? 'a'.repeat(3_001) : index === 1 ? undefined : null })))
      : path.includes('/pulls?') ? err('Private pull request evidence unavailable') : ok([]),
  })
  expect(result.ownership).toMatchObject({
    _tag: 'Available',
    issues: { _tag: 'Available', truncated: true, entries: [
      { number: 1, body: { _tag: 'Truncated', text: 'a'.repeat(3_000) } },
      { number: 2, body: { _tag: 'Unavailable', reason: 'GitHub did not supply this body.' } },
      ...Array.from({ length: 18 }, (_, index) => ({ number: index + 3, body: { _tag: 'Complete', text: '' } })),
    ] },
    pullRequests: { _tag: 'Unavailable', reason: 'Private pull request evidence unavailable' },
  })
})

it('keeps CI and deployment evidence when a frequent workflow fills the recent runs', async () => {
  const workflowRuns = [
    { id: 13, name: 'Summary', head_branch: 'release/checkin', created_at: '2026-10-10T07:00:00Z', conclusion: 'success' },
    { id: 12, name: 'CI', head_branch: 'release/checkin', created_at: '2026-10-09T07:00:00Z', conclusion: 'failure' },
    { id: 11, name: 'Deploy', head_branch: 'release/checkin', created_at: '2026-10-08T07:00:00Z', conclusion: 'success' },
  ]
  const result = await collectRoutineGitHubEvidence({
    repository: 'harlan-zw/example',
    workflowBranch: 'release/checkin',
    now: () => new Date('2026-10-10T07:00:00Z'),
    read: async (path) => {
      const url = new URL(path, 'https://api.github.com')
      if (url.pathname.endsWith('/actions/workflows'))
        return ok({ total_count: 4, workflows: [{ id: 1, state: 'active' }, { id: 2, state: 'active' }, { id: 3, state: 'active' }, { id: 4, state: 'disabled_manually' }] })
      if (url.pathname.includes('/actions/workflows/')) {
        if (url.searchParams.get('branch') !== 'release/checkin')
          return err('The workflow read used the wrong branch.')
        const workflowId = Number(url.pathname.split('/').at(-2))
        const run = workflowRuns[workflowId - 1]
        return run === undefined ? err('Disabled workflow must not be read.') : ok({ workflow_runs: [run] })
      }
      return ok(url.pathname.endsWith('/actions/runs') ? { workflow_runs: Array.from({ length: 10 }, (_, index) => ({ ...workflowRuns[0], id: 100 + index })) } : [])
    },
  })
  expect(result.workflowRuns).toEqual({ _tag: 'Available', entries: workflowRuns, truncated: false })
})

it('reports incomplete workflow evidence when a workflow read fails', async () => {
  const result = await collectRoutineGitHubEvidence({
    repository: 'harlan-zw/example',
    workflowBranch: 'main',
    now: () => new Date('2026-10-10T07:00:00Z'),
    read: async path => path.includes('/actions/workflows?')
      ? ok({ total_count: 1, workflows: [{ id: 2, state: 'active' }] })
      : path.includes('/actions/workflows/2/runs?') ? err('Workflow access unavailable') : ok([]),
  })
  expect(result.workflowRuns).toEqual({ _tag: 'Unavailable', reason: 'Workflow access unavailable' })
})

it('preserves failed job evidence without treating commit statuses as Actions jobs', async () => {
  const requested: number[] = []
  const result = await collectRepairGitHubEvidence({
    mapping: repositoryMapping(),
    signal: new AbortController().signal,
    snapshot: { _tag: 'Available', checks: [
      { id: 1, name: 'test', status: 'completed', conclusion: 'failure', failure: { _tag: 'StepFailed' }, source: { _tag: 'CheckRun', appId: 15368 } },
      { id: 2, name: 'external', status: 'completed', conclusion: 'failure', failure: { _tag: 'NotAsked' }, source: { _tag: 'CommitStatus' } },
    ] },
    source: { getFailedJobContext: async (_mapping, id) => {
      requested.push(id)
      return ok({ runId: 12, jobName: 'test', failedStep: 'Run test', logTail: ['pnpm dev:prepare', 'ghp_12345678901234567890'] })
    } },
  })
  expect(requested).toEqual([1])
  expect(JSON.stringify(result)).toContain('pnpm dev:prepare')
  expect(JSON.stringify(result)).not.toContain('12345678901234567890')
})

it('preserves unreadable private sections instead of reporting an empty successful read', async () => {
  const result = await collectRoutineGitHubEvidence({ repository: 'harlan-zw/example', now: () => new Date('2026-10-07T00:00:00Z'), read: async path => path.includes('/issues?') ? err('private read unavailable') : ok([]) })
  expect(result.issues).toEqual({ _tag: 'Unavailable', reason: 'private read unavailable' })
  expect(result.deployments).toEqual({ _tag: 'Available', entries: [], truncated: false })
})

it('bounds and minimizes metadata before it reaches a worker', async () => {
  const result = await collectRoutineGitHubEvidence({ repository: 'harlan-zw/example', now: () => new Date('2026-10-07T00:00:00Z'), read: async path => ok(path.includes('/issues?') ? Array.from({ length: 21 }, (_, index) => ({ number: index, title: 'a'.repeat(2000), body: 'private body', user: { token: 'secret' }, pull_request: index === 0 ? {} : undefined })) : []) })
  expect(result.issues._tag).toBe('Available')
  expect(JSON.stringify(result)).not.toContain('private body')
  expect(JSON.stringify(result)).not.toContain('secret')
  expect(JSON.stringify(result).length).toBeLessThan(15_000)
})

describe('job execution context', () => {
  it('retains preparation before a long failed log tail and records shell plus cwd', () => {
    const result = jobExecutionContext(['2026-10-07T00:00:00Z ##[group]Run pnpm dev:prepare', '2026-10-07T00:00:00Z pnpm dev:prepare', '2026-10-07T00:00:00Z shell: /usr/bin/bash -e {0}', '2026-10-07T00:00:00Z working-directory: packages/site', '2026-10-07T00:00:00Z ##[endgroup]', ...Array.from<string>({ length: 100 }).fill('output')])
    expect(result).toEqual([{ run: 'pnpm dev:prepare', shell: '/usr/bin/bash -e {0}', workingDirectory: 'packages/site' }])
  })
})

it('keeps successful check warnings and exact multi-command preparation', async () => {
  const result = await collectRoutineGitHubEvidence({
    repository: 'harlan-zw/example',
    now: () => new Date('2026-10-07T00:00:00Z'),
    includeSuccessfulJobs: true,
    read: async path => ok(path.includes('/actions/runs?') ? { workflow_runs: [{ id: 12, conclusion: 'success' }] } : path.includes('/jobs?') ? { jobs: [{ id: 13, name: 'test' }] } : []),
    readJob: async () => ok({ runId: 12, jobName: 'test', failedStep: null, logTail: ['warning: missing cache'] }),
  })
  expect(JSON.stringify(result.jobLogs)).toContain('warning: missing cache')
  const commands = jobExecutionContext(['##[group]Run pnpm install', 'pnpm install', 'pnpm dev:prepare', 'pnpm test', 'shell: bash -e {0}', '##[endgroup]'])
  expect(commands[0]?.run).toBe('pnpm install\npnpm dev:prepare\npnpm test')
})

it('requests independent read grants so unavailable deployments do not impersonate empty metadata', async () => {
  const accesses: string[] = []
  const source = createRoutineGitHubEvidenceSource({
    tokens: { getToken: async (_repository, access) => {
      accesses.push(access)
      return err({ repository: 'harlan-zw/example', message: `Unavailable ${access}` })
    }, invalidate: () => undefined },
    now: () => new Date('2026-10-07T00:00:00Z'),
    jobs: { getFailedJobContext: async () => err('unexpected log read') },
  })
  const result = await source.collect(repositoryMapping(), new AbortController().signal)
  expect(accesses.sort()).toEqual(['checks_read', 'deployments_read', 'read'])
  expect(result.issues).toEqual({ _tag: 'Unavailable', reason: 'Unavailable read' })
  expect(result.deployments).toEqual({ _tag: 'Unavailable', reason: 'Unavailable deployments_read' })
})

it('rejects malformed metadata rather than treating it as no open work', async () => {
  const result = await collectRoutineGitHubEvidence({ repository: 'harlan-zw/example', now: () => new Date('2026-10-07T00:00:00Z'), read: async () => ok([null]) })
  expect(result.issues).toEqual({ _tag: 'Unavailable', reason: 'GitHub returned an invalid metadata entry.' })
})

it('keeps controller authentication in the transport and supplies deployment status snapshots', async () => {
  const auth: string[] = []
  const source = createRoutineGitHubEvidenceSource({
    tokens: { getToken: async () => ok({ token: 'controller-secret', expiresAt: '2026-10-07T01:00:00Z' }), invalidate: () => undefined },
    now: () => new Date('2026-10-07T00:00:00Z'),
    jobs: { getFailedJobContext: async () => err('unexpected log read') },
    createClient: options => new Octokit({ ...options, request: { fetch: async (url: string, init: RequestInit) => {
      auth.push(String((init.headers as Record<string, string>).authorization))
      const path = new URL(url).pathname
      const payload = path.endsWith('/statuses') ? [{ state: 'success', created_at: '2026-10-07T00:00:00Z', description: 'Ready' }] : path.endsWith('/deployments') ? [{ id: 42, environment: 'production', payload: { token: 'private-payload' } }] : path.endsWith('/runs') ? { workflow_runs: [] } : []
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    } } } as never),
  })
  const result = await source.collect(repositoryMapping(), new AbortController().signal)
  expect(auth).toEqual(Array.from<string>({ length: 5 }).fill('token controller-secret'))
  expect(result.deploymentStatuses).toEqual([{ deploymentId: 42, evidence: { _tag: 'Available', entries: [{ state: 'success', created_at: '2026-10-07T00:00:00Z', description: 'Ready' }], truncated: false } }])
  expect(JSON.stringify(result)).not.toContain('controller-secret')
  expect(JSON.stringify(result)).not.toContain('private-payload')
})
