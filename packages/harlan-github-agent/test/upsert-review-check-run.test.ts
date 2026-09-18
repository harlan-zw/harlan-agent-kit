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
    paginate: (method: unknown) => method === listForRef ? Promise.resolve(existingRuns) : Promise.resolve([]),
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
})!

const completed = reviewCheckRunUpdate({
  taskKind: 'adversarial_review',
  phase: 'terminal',
  desiredOutcome: 'READY',
  body: '<!-- harlan-agent-kit:pr-triage -->\n### 🤖 READY · Adversarial review',
})!

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

  it('completes the check run with its conclusion', async () => {
    const { source: github, update } = source([
      { id: 500, name: REVIEW_CHECK_RUN_NAME, app: { id: ownAppId } },
    ])

    await github.upsertReviewCheckRun(repositoryMapping(), headSha, completed, new AbortController().signal)

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      check_run_id: 500,
      status: 'completed',
      conclusion: 'success',
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
})
