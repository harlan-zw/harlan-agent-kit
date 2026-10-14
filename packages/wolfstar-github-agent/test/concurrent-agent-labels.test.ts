import type { Octokit } from 'octokit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { err, ok } from '../src/result.ts'
import { repositoryMapping } from './fixtures.ts'

const fixture = vi.hoisted(() => {
  const labels = new Map<number, Set<string>>()
  const held = (number: number) => labels.get(number) ?? new Set<string>()
  const response = (number: number) => ({ data: [...held(number)].map((name) => ({ name })) })
  const octokit = {
    rest: {
      issues: {
        get: async ({ issue_number }: { issue_number: number; request?: { signal: AbortSignal } }) => ({
          data: { labels: response(issue_number).data },
        }),
        createLabel: async () => ({ data: {} }),
        addLabels: async ({ issue_number, labels: added }: { issue_number: number; labels: string[] }) => {
          labels.set(issue_number, new Set([...held(issue_number), ...added]))
          return response(issue_number)
        },
        removeLabel: async ({
          issue_number,
          name,
        }: {
          issue_number: number
          name: string
          request?: { signal: AbortSignal }
        }) => {
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
    actorLogin: () => 'wolfstar-agent[bot]',
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

afterEach(() => vi.useRealTimers())

describe('concurrent Agent label writes', () => {
  it('gives a queued Running-label cleanup its full write deadline', async () => {
    vi.useFakeTimers()
    const deadline = () => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new Error('The label write timed out.')), 30_000)
      return controller.signal
    }
    const read = fixture.octokit.rest.issues.get
    vi.spyOn(fixture.octokit.rest.issues, 'get').mockImplementation(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 25_000))
      request.request!.signal.throwIfAborted()
      return read(request)
    })
    const remove = fixture.octokit.rest.issues.removeLabel
    vi.spyOn(fixture.octokit.rest.issues, 'removeLabel').mockImplementation(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 25_000))
      request.request!.signal.throwIfAborted()
      return remove(request)
    })
    const github = source()
    const repository = repositoryMapping()

    const running = github.stampAgentLabel(repository, 24, 'RUNNING', deadline)
    const cleanup = github.clearRunningLabel(repository, 24, deadline)
    await vi.advanceTimersByTimeAsync(50_000)

    expect(await running).toEqual(ok(undefined))
    expect(await cleanup).toEqual(ok(undefined))
    expect([...fixture.labels.get(24)!]).toEqual([])
  })

  it('does not start a cancelled queued stamp', async () => {
    const pending = Promise.withResolvers<void>()
    const read = fixture.octokit.rest.issues.get
    const reads: number[] = []
    vi.spyOn(fixture.octokit.rest.issues, 'get').mockImplementation(async (request) => {
      reads.push(request.issue_number)
      await pending.promise
      return read(request)
    })
    const github = source()
    const repository = repositoryMapping()
    const cancellation = new AbortController()
    const first = github.stampAgentLabel(repository, 24, 'RUNNING', new AbortController().signal)
    const cancelled = github.stampAgentLabel(repository, 24, 'BLOCKED', cancellation.signal)
    cancellation.abort(new Error('The caller cancelled the write.'))
    pending.resolve()

    expect(await first).toEqual(ok(undefined))
    expect(await cancelled).toEqual(err('The caller cancelled the write.'))
    expect(reads).toEqual([24])
    expect([...fixture.labels.get(24)!]).toEqual(['wolfstar-agent-running'])
  })

  it('settles competing Running and Review stamps in request order', async () => {
    fixture.labels.set(24, new Set(['bug', 'wolfstar-agent-ready']))
    const github = source()
    const repository = repositoryMapping()
    const signal = AbortSignal.timeout(1000)

    const results = await Promise.all([
      github.stampAgentLabel(repository, 24, 'RUNNING', signal),
      github.stampAgentLabel(repository, 24, 'BLOCKED', signal),
    ])

    expect(results).toEqual([ok(undefined), ok(undefined)])
    expect([...fixture.labels.get(24)!].sort()).toEqual(['bug', 'wolfstar-agent-blocked'])
  })

  it('clears the stamp that precedes a full label clear', async () => {
    fixture.labels.set(24, new Set(['bug', 'wolfstar-agent-ready']))
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

    expect(
      await Promise.all([
        github.stampAgentLabel(repository, 24, 'RUNNING', signal),
        github.clearRunningLabel(repository, 24, signal),
      ]),
    ).toEqual([ok(undefined), ok(undefined)])
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
    const verdict = github.stampAgentLabel(repository, 24, 'BLOCKED', signal, () =>
      authorized ? ok(undefined) : err('The Review ended.'),
    )
    authorized = false
    pending.resolve()

    expect(await running).toEqual(ok(undefined))
    expect(await verdict).toEqual(err('The Review ended.'))
    expect([...fixture.labels.get(24)!]).toEqual(['wolfstar-agent-running'])
  })

  it('continues queued label writes after an earlier read fails', async () => {
    vi.spyOn(fixture.octokit.rest.issues, 'get').mockRejectedValueOnce(new Error('GitHub timed out.'))
    const github = source()
    const repository = repositoryMapping()
    const signal = AbortSignal.timeout(1000)

    expect(
      await Promise.all([
        github.stampAgentLabel(repository, 24, 'RUNNING', signal),
        github.stampAgentLabel(repository, 24, 'READY', signal),
      ]),
    ).toEqual([err('GitHub timed out.'), ok(undefined)])
    expect([...fixture.labels.get(24)!]).toEqual(['wolfstar-agent-ready'])
  })

  it('lets another Item proceed while one label read waits', async () => {
    const pending = Promise.withResolvers<void>()
    const read = fixture.octokit.rest.issues.get
    vi.spyOn(fixture.octokit.rest.issues, 'get').mockImplementation(async (request) => {
      if (request.issue_number === 24) await pending.promise
      return read(request)
    })
    const github = source()
    const repository = repositoryMapping()
    const signal = AbortSignal.timeout(1000)
    const first = github.stampAgentLabel(repository, 24, 'RUNNING', signal)
    try {
      expect(await github.stampAgentLabel(repository, 25, 'READY', signal)).toEqual(ok(undefined))
      expect([...fixture.labels.get(25)!]).toEqual(['wolfstar-agent-ready'])
    } finally {
      pending.resolve()
      await first
    }
  })
})
