import type { Octokit } from 'octokit'
import { describe, expect, it, vi } from 'vitest'
import { createGitHubAgentSource } from '../src/github-agent-source.ts'
import { err, ok } from '../src/result.ts'
import { REVIEW_CHECK_RUN_NAME, reviewCheckRunUpdate } from '../src/review-check-run.ts'
import { repositoryMapping } from './fixtures.ts'

const headSha = '1031dc93dddca88266cb32a085c7b90dcd58ec23'
const ownAppId = 98114

function source(existingRuns: unknown[]) {
  const create = vi.fn((_input: { head_sha?: string, name?: string, status?: string }) => Promise.resolve({ data: { id: 900 } }))
  const update = vi.fn((_input: { check_run_id?: number, status?: string }) => Promise.resolve({ data: { id: 500 } }))
  const listForRef = () => undefined
  const client = {
    paginate: (method: unknown, input: { app_id?: number }) => {
      if (method === listForRef && input.app_id === ownAppId)
        return Promise.resolve(existingRuns)
      return Promise.resolve([])
    },
    rest: {
      checks: { create, listForRef, update },
    },
  } as unknown as Octokit
  return {
    create,
    source: createGitHubAgentSource({
      actorLogin: () => 'harlan-github-agent[bot]',
      createClient: () => client,
      ownAppId,
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'app-token', expiresAt: '2026-09-30T00:00:00.000Z' })),
        invalidate: () => undefined,
      },
    }),
    update,
  }
}

const running = reviewCheckRunUpdate({
  taskKind: 'adversarial_review',
  phase: 'review',
  desiredOutcome: null,
  body: '<!-- harlan-agent-kit:pr-triage -->\n### 🤖 REVIEWING · 55% · Reviewing changed files',
}, '2026-09-18T20:00:00.000Z')!

const completed = reviewCheckRunUpdate({
  taskKind: 'adversarial_review',
  phase: 'terminal',
  desiredOutcome: 'READY',
  body: '<!-- harlan-agent-kit:pr-triage -->\n### 🤖 READY · Adversarial review',
}, '2026-09-18T20:00:00.000Z')!

describe('upsert review check run', () => {
  it('creates the named check run on the head commit when none exists', async () => {
    const { create, source: github, update } = source([])

    const result = await github.upsertReviewCheckRun(repositoryMapping(), headSha, running, new AbortController().signal)

    expect(result).toEqual(ok(undefined))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      head_sha: headSha,
      name: REVIEW_CHECK_RUN_NAME,
      status: 'in_progress',
      output: expect.objectContaining({ title: '🤖 REVIEWING · 55% · Reviewing changed files' }),
    }))
    expect(update).not.toHaveBeenCalled()
  })

  it('updates this app\'s own check run in place', async () => {
    const { create, source: github, update } = source([
      { id: 500, name: REVIEW_CHECK_RUN_NAME, app: { id: ownAppId } },
    ])

    const result = await github.upsertReviewCheckRun(repositoryMapping(), headSha, running, new AbortController().signal)

    expect(result).toEqual(ok(undefined))
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ check_run_id: 500, status: 'in_progress' }))
    expect(create).not.toHaveBeenCalled()
  })

  it('ignores another app\'s check run that carries the same name', async () => {
    const { create, source: github, update } = source([
      { id: 501, name: REVIEW_CHECK_RUN_NAME, app: { id: 9999 } },
    ])

    await github.upsertReviewCheckRun(repositoryMapping(), headSha, running, new AbortController().signal)

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ head_sha: headSha }))
    expect(update).not.toHaveBeenCalled()
  })

  it('completes the check run with its conclusion and completion time', async () => {
    const { source: github, update } = source([
      { id: 500, name: REVIEW_CHECK_RUN_NAME, app: { id: ownAppId } },
    ])

    await github.upsertReviewCheckRun(repositoryMapping(), headSha, completed, new AbortController().signal)

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      check_run_id: 500,
      status: 'completed',
      conclusion: 'success',
      completed_at: '2026-09-18T20:00:00.000Z',
    }))
  })

  it('refuses the write when publication authority is gone', async () => {
    const { create, source: github, update } = source([])

    const result = await github.upsertReviewCheckRun(
      repositoryMapping(),
      headSha,
      running,
      new AbortController().signal,
      () => err('The Review publication lost its current authority before the GitHub write.'),
    )

    expect(result).toEqual(err('The Review publication lost its current authority before the GitHub write.'))
    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('returns the rejection instead of throwing when GitHub refuses the write', async () => {
    const listForRef = () => undefined
    const client = {
      paginate: (_method: unknown, input: { app_id?: number }) => input.app_id === ownAppId ? Promise.resolve([]) : Promise.resolve([]),
      rest: {
        checks: {
          create: () => Promise.reject(new Error('Resource not accessible by integration')),
          listForRef,
          update: () => Promise.reject(new Error('Resource not accessible by integration')),
        },
      },
    } as unknown as Octokit
    const github = createGitHubAgentSource({
      actorLogin: () => 'harlan-github-agent[bot]',
      createClient: () => client,
      ownAppId,
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'app-token', expiresAt: '2026-09-30T00:00:00.000Z' })),
        invalidate: () => undefined,
      },
    })

    await expect(github.upsertReviewCheckRun(repositoryMapping(), headSha, running, new AbortController().signal))
      .resolves
      .toEqual(err('Resource not accessible by integration'))
  })

  it('skips the mirror entirely on a user-token repository', async () => {
    const { create, source: github, update } = source([])

    const result = await github.upsertReviewCheckRun(repositoryMapping({ authentication: 'user' }), headSha, running, new AbortController().signal)

    expect(result).toEqual(ok(undefined))
    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('serializes two first publications for one head into one check run', async () => {
    let releaseWrite: (() => void) | undefined
    let createStarted: () => void = () => {}
    const started = new Promise<void>(resolve => (createStarted = resolve))
    const writes: string[] = []
    const runs: unknown[] = []
    const listForRef = () => undefined
    const client = {
      paginate: (_method: unknown, input: { app_id?: number }) => {
        if (input.app_id === ownAppId)
          return Promise.resolve([...runs])
        return Promise.resolve([])
      },
      rest: {
        checks: {
          create: vi.fn((_input: { head_sha?: string }) => {
            writes.push('create')
            createStarted()
            return new Promise((resolve) => {
              releaseWrite = () => {
                runs.push({ id: 900, name: REVIEW_CHECK_RUN_NAME, status: 'in_progress', conclusion: null, app: { id: ownAppId } })
                resolve({ data: { id: 900 } })
              }
            })
          }),
          listForRef,
          update: vi.fn((input: { check_run_id?: number }) => {
            writes.push(`update ${input.check_run_id}`)
            return Promise.resolve({ data: { id: 500 } })
          }),
        },
      },
    } as unknown as Octokit
    const github = createGitHubAgentSource({
      actorLogin: () => 'harlan-github-agent[bot]',
      createClient: () => client,
      ownAppId,
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'app-token', expiresAt: '2026-09-30T00:00:00.000Z' })),
        invalidate: () => undefined,
      },
    })

    const first = github.upsertReviewCheckRun(repositoryMapping(), headSha, running, new AbortController().signal)
    await started
    // The second publication queues behind the first one's pending create.
    const second = github.upsertReviewCheckRun(repositoryMapping(), headSha, running, new AbortController().signal)
    releaseWrite?.()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toEqual(ok(undefined))
    expect(secondResult).toEqual(ok(undefined))
    expect(writes).toEqual(['create', 'update 900'])
  })

  it('completes a stranded duplicate check run as neutral when one appears', async () => {
    const { source: github, update } = source([
      { id: 500, name: REVIEW_CHECK_RUN_NAME, status: 'in_progress', conclusion: null, app: { id: ownAppId } },
      { id: 700, name: REVIEW_CHECK_RUN_NAME, status: 'in_progress', conclusion: null, app: { id: ownAppId } },
    ])

    const result = await github.upsertReviewCheckRun(repositoryMapping(), headSha, completed, new AbortController().signal)

    expect(result).toEqual(ok(undefined))
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ check_run_id: 700, status: 'completed', conclusion: 'success' }))
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ check_run_id: 500, status: 'completed', conclusion: 'neutral' }))
  })
})
