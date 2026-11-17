import type { Questions, SystemOneResult } from 'advocaat'
import type { ClassificationSource } from '../src/classification.ts'
import { describe, expect, it } from 'vitest'
import { createPullRequestTriageController } from '../src/pull-request-triage.ts'
import { reconcileRepository } from '../src/reconcile.ts'
import { ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const headSha = 'a'.repeat(40)

const noFinalRead = {
  getIssue: () => Promise.reject(new Error('No issue should need a final read.')),
  getPullRequest: () => Promise.reject(new Error('No pull request should need a final read.')),
}

function skipAnswer(): ClassificationSource {
  return {
    classify: <Q extends Questions>() => Promise.resolve(ok({
      model: 'jev-1.13.0',
      answers: { review: { type: 'choice', choice: 'ADVERSARIAL_REVIEW_SKIPPED', confidence: 0.95, probabilities: {} } },
      usage: { input_tokens: 10, output_tokens: 0 },
    } as SystemOneResult<Q>)),
  }
}

/** Polls one clean pull request twice through the real triage controller and store. */
async function pollTwice(input: { files: string[], pathRuleShadow: boolean, classification?: ClassificationSource }) {
  const store = openJournalStore(':memory:', true)
  const repository = repositoryMapping()
  store.syncRepositories([repository], '2026-11-17T00:00:00.000Z')
  store.setRepositoryWritesEnabled(repository.github, true)
  const subject = pullRequestItem({ mergeState: 'clean', headSha })
  let minute = 0
  const now = () => new Date(`2026-11-17T01:0${minute++}:00.000Z`)
  const pullRequestTriage = createPullRequestTriageController({
    classification: input.classification ?? null,
    github: {
      listPullRequestFiles: () => Promise.resolve(ok(input.files.map(path => ({ path, status: 'modified' as const, additions: 1, deletions: 0, previousFilename: null })))),
      consumeApprovalLabel: () => Promise.resolve(ok(undefined)),
      stampAgentLabel: () => Promise.resolve(ok(undefined)),
      upsertReviewCheckRun: () => Promise.resolve(ok(undefined)),
      upsertReviewStatus: () => Promise.resolve(ok({ commentId: 7, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-7' })),
    },
    now,
    reportCheckRun: () => {},
    store,
    pathRuleShadow: input.pathRuleShadow,
  })
  const poll = () => reconcileRepository(repository, {
    github: { ...noFinalRead, listOpenItems: () => Promise.resolve(ok([subject])) },
    store,
    now,
    pullRequestTriage,
  })
  try {
    expect((await poll())._tag).toBe('Ok')
    expect((await poll())._tag).toBe('Ok')
    return {
      events: store.listWorkflowEvents({ stream: 'review_run' }).filter(event => event.event === 'path_rule_shadow'),
      review: store.claimNextAdversarialReviewTask('reviewer-1', '2026-11-17T01:10:00.000Z', 60_000),
    }
  }
  finally {
    store.close()
  }
}

describe('path rule shadow', () => {
  it('records a prose-only head once and still queues its Review', async () => {
    const { events, review } = await pollTwice({ files: ['README.md', 'docs/guide.md'], pathRuleShadow: true })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ repository: 'harlan-zw/example', itemNumber: 24, from: null, to: 'ProseOnly' })
    expect(JSON.parse(events[0]!.reason!)).toEqual({ verdict: 'ProseOnly', fileCount: 2 })
    expect(review?.pullRequest.headSha).toBe(headSha)
  })

  it.each([
    ['a lockfile-only change', ['pnpm-lock.yaml']],
    ['a source change', ['README.md', 'src/index.ts']],
  ])('records nothing for %s, which the path rule sends to Review', async (_label, files) => {
    const { events, review } = await pollTwice({ files, pathRuleShadow: true })

    expect(events).toEqual([])
    expect(review?.pullRequest.headSha).toBe(headSha)
  })

  it('records nothing while the flag is off', async () => {
    const { events, review } = await pollTwice({ files: ['README.md'], pathRuleShadow: false })

    expect(events).toEqual([])
    expect(review?.pullRequest.headSha).toBe(headSha)
  })

  it('records nothing when Pull request triage already skipped Review', async () => {
    const { events, review } = await pollTwice({ files: ['README.md'], pathRuleShadow: true, classification: skipAnswer() })

    expect(events).toEqual([])
    expect(review).toBeNull()
  })
})
