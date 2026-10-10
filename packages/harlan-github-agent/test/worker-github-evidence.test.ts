import { Octokit } from 'octokit'
import { describe, expect, it } from 'vitest'
import { err, ok } from '../src/result.ts'
import { collectRepairGitHubEvidence, collectRoutineGitHubEvidence, createRoutineGitHubEvidenceSource, jobExecutionContext } from '../src/worker-github-evidence.ts'
import { repositoryMapping } from './fixtures.ts'

it('collects daily check-in workflow evidence for the mapped branch', async () => {
  const paths: string[] = []
  const result = await collectRoutineGitHubEvidence({ repository: 'harlan-zw/example', workflowBranch: 'main', now: () => new Date('2026-10-10T07:00:00Z'), read: async (path) => {
    paths.push(path)
    return ok(path.includes('/actions/runs?') ? { workflow_runs: [{ id: 12, name: 'CI', head_branch: 'main', updated_at: '2026-10-10T07:00:00Z' }] } : [])
  } })
  expect(paths).toContain('/repos/harlan-zw/example/actions/runs?per_page=10&branch=main')
  expect(result.workflowRuns).toMatchObject({ entries: [{ id: 12, head_branch: 'main', updated_at: '2026-10-10T07:00:00Z' }] })
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
