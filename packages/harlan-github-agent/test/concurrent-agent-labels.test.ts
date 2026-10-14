import type { Octokit } from 'octokit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { err, ok } from '../src/result.ts'
import { repositoryMapping } from './fixtures.ts'

const fixture = vi.hoisted(() => {
  const labels = new Map<number, Set<string>>()
  const held = (number: number) => labels.get(number) ?? new Set<string>()
  const response = (number: number) => ({ data: [...held(number)].map(name => ({ name })) })
  const octokit = {
    rest: {
      issues: {
        get: async ({ issue_number }: { issue_number: number }) => ({ data: { labels: response(issue_number).data } }),
        createLabel: async () => ({ data: {} }),
        addLabels: async ({ issue_number, labels: added }: { issue_number: number, labels: string[] }) => {
          labels.set(issue_number, new Set([...held(issue_number), ...added]))
          return response(issue_number)
        },
        removeLabel: async ({ issue_number, name }: { issue_number: number, name: string }) => {
          held(issue_number).delete(name)
          return response(issue_number)
        },
      },
    },
  }
  return { labels, octokit }
})

vi.mock('../src/github-auth.ts', () => ({
  createAuthenticatedClient: () => fixture.octokit as unknown as Octokit,
}))

const { createGitHubAgentSource } = await import('../src/github-agent-source.ts')

function source() {
  return createGitHubAgentSource({
    actorLogin: () => 'harlan-agent[bot]',
    ownAppId: 98114,
    tokens: {
      getToken: async () => ok({ token: 'token', expiresAt: '2026-10-14T02:00:00.000Z' }),
      invalidate: () => undefined,
    },
  })
}

beforeEach(() => {
  fixture.labels.clear()
  vi.restoreAllMocks()
})

describe('concurrent Agent label writes', () => {
  it('settles competing Running and Review stamps in request order', async () => {
    fixture.labels.set(24, new Set(['bug', 'harlan-agent-ready']))
    const github = source()
    const repository = repositoryMapping()
    const signal = AbortSignal.timeout(1000)

    const results = await Promise.all([
      github.stampAgentLabel(repository, 24, 'RUNNING', signal),
      github.stampAgentLabel(repository, 24, 'BLOCKED', signal),
    ])

    expect(results).toEqual([ok(undefined), ok(undefined)])
    expect([...fixture.labels.get(24)!].sort()).toEqual(['bug', 'harlan-agent-blocked'])
  })

  it('clears the stamp that precedes a full label clear', async () => {
    fixture.labels.set(24, new Set(['bug', 'harlan-agent-ready']))
    const github = source()
    const repository = repositoryMapping()
    const signal = AbortSignal.timeout(1000)

    const results = await Promise.all([
      github.stampAgentLabel(repository, 24, 'RUNNING', signal),
      github.clearAgentLabels(repository, 24, signal),
    ])

    expect(results).toEqual([ok(undefined), ok(undefined)])
    expect([...fixture.labels.get(24)!]).toEqual(['bug'])
  })

  it('clears Running after a concurrent stamp without removing human labels', async () => {
    fixture.labels.set(24, new Set(['bug']))
    const github = source()
    const repository = repositoryMapping()
    const signal = AbortSignal.timeout(1000)

    expect(await Promise.all([
      github.stampAgentLabel(repository, 24, 'RUNNING', signal),
      github.clearRunningLabel(repository, 24, signal),
    ])).toEqual([ok(undefined), ok(undefined)])
    expect([...fixture.labels.get(24)!]).toEqual(['bug'])
  })

  it('rechecks publication authority after an earlier stamp completes', async () => {
    const pending = Promise.withResolvers<void>()
    const read = fixture.octokit.rest.issues.get
    vi.spyOn(fixture.octokit.rest.issues, 'get').mockImplementationOnce(async (request) => {
      await pending.promise
      return read(request)
    })
    const github = source()
    const repository = repositoryMapping()
    const signal = AbortSignal.timeout(1000)
    let authorized = true
    const running = github.stampAgentLabel(repository, 24, 'RUNNING', signal)
    const verdict = github.stampAgentLabel(repository, 24, 'BLOCKED', signal, () => authorized ? ok(undefined) : err('The Review ended.'))
    authorized = false
    pending.resolve()

    expect(await running).toEqual(ok(undefined))
    expect(await verdict).toEqual(err('The Review ended.'))
    expect([...fixture.labels.get(24)!]).toEqual(['harlan-agent-running'])
  })

  it('continues queued label writes after an earlier read fails', async () => {
    vi.spyOn(fixture.octokit.rest.issues, 'get').mockRejectedValueOnce(new Error('GitHub timed out.'))
    const github = source()
    const repository = repositoryMapping()
    const signal = AbortSignal.timeout(1000)

    expect(await Promise.all([
      github.stampAgentLabel(repository, 24, 'RUNNING', signal),
      github.stampAgentLabel(repository, 24, 'READY', signal),
    ])).toEqual([err('GitHub timed out.'), ok(undefined)])
    expect([...fixture.labels.get(24)!]).toEqual(['harlan-agent-ready'])
  })

  it('lets another Item proceed while one label read waits', async () => {
    const pending = Promise.withResolvers<void>()
    const read = fixture.octokit.rest.issues.get
    vi.spyOn(fixture.octokit.rest.issues, 'get').mockImplementation(async (request) => {
      if (request.issue_number === 24)
        await pending.promise
      return read(request)
    })
    const github = source()
    const repository = repositoryMapping()
    const signal = AbortSignal.timeout(1000)
    const first = github.stampAgentLabel(repository, 24, 'RUNNING', signal)
    try {
      expect(await github.stampAgentLabel(repository, 25, 'READY', signal)).toEqual(ok(undefined))
      expect([...fixture.labels.get(25)!]).toEqual(['harlan-agent-ready'])
    }
    finally {
      pending.resolve()
      await first
    }
  })
})
