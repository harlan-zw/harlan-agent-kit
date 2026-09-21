import type { Questions, SystemOneResult } from 'advocaat'
import type { ClassificationSource } from '../src/classification.ts'
import type { RepositoryMapping } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { createIssueClassificationController, issueRouteQuestions, routedResult } from '../src/issue-classification.ts'
import { ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { issueItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => stores.splice(0).forEach(store => store.close()))

function createStore() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  return store
}

interface RouteAnswers {
  route: 'NEEDS_INFO' | 'WAIT_TO_IMPLEMENT' | 'AGENT_TRIAGE'
  routeConfidence: number
  difficulty?: number
  impact?: number
  hasReproduction?: number
  needsCodebaseReview?: number
}

function classificationAnswer(answers: RouteAnswers): ClassificationSource {
  return {
    classify: <Q extends Questions>() => Promise.resolve({
      _tag: 'Ok' as const,
      value: {
        model: 'jev-1.13.0',
        answers: {
          route: { type: 'choice', choice: answers.route, confidence: answers.routeConfidence, probabilities: {} },
          difficulty: { type: 'score', score: answers.difficulty ?? 1, confidence: 0.9, legend: {}, probabilities: {} },
          impact: { type: 'score', score: answers.impact ?? 2, confidence: 0.9, legend: {}, probabilities: {} },
          hasReproduction: { type: 'noul', noul: answers.hasReproduction ?? 0.8 },
          needsCodebaseReview: { type: 'noul', noul: answers.needsCodebaseReview ?? 0.1 },
        },
      } as unknown as SystemOneResult<Q>,
    }),
  }
}

function controller(input: {
  answers: RouteAnswers
  band: number | null
  comments?: string[]
  labels?: string[]
}) {
  const issue = issueItem()
  return {
    issue,
    decision: () => createIssueClassificationController({
      classification: classificationAnswer(input.answers),
      band: input.band,
      github: {
        getIssueTriageSnapshot: () => Promise.resolve(ok({
          body: 'Steps: open the app. Nothing happens.',
          comments: [],
          state: 'open' as const,
          title: 'Button does nothing',
          updatedAt: '2026-09-18T00:00:00.000Z',
        })),
        stampAgentLabel: (_repository: RepositoryMapping, _number: number, state) => {
          input.labels?.push(state)
          return Promise.resolve(ok(undefined))
        },
        upsertIssueTriageComment: (_repository: RepositoryMapping, _number: number, _commentId: number | null, body: string) => {
          input.comments?.push(body)
          return Promise.resolve(ok({ commentId: 5, url: 'https://github.com/harlan-zw/example/issues/7#issuecomment-5' }))
        },
      },
    }).verdict(repositoryMapping(), issue, new AbortController().signal),
  }
}

describe('issue triage classification', () => {
  it('keeps the Agent turn when no band is configured', async () => {
    const harness = controller({ answers: { route: 'NEEDS_INFO', routeConfidence: 0.99 }, band: null })
    await expect(harness.decision()).resolves.toMatchObject({ _tag: 'AgentTriage' })
  })

  it('routes a confident needs-info report without the Agent', async () => {
    const harness = controller({ answers: { route: 'NEEDS_INFO', routeConfidence: 0.95 }, band: 0.9 })
    const decision = await harness.decision()
    expect(decision).toMatchObject({
      _tag: 'Routed',
      confidence: 0.95,
      result: { _tag: 'NEEDS_INFO', difficulty: 2, impact: 3, hasReproduction: true },
    })
    if (decision._tag === 'Routed')
      expect(decision.title).toBe('Button does nothing')
  })

  it('keeps the Agent turn below the band, for ready work, and when the codebase must be read', async () => {
    await expect(controller({ answers: { route: 'NEEDS_INFO', routeConfidence: 0.7 }, band: 0.9 }).decision()).resolves.toMatchObject({ _tag: 'AgentTriage' })
    await expect(controller({ answers: { route: 'AGENT_TRIAGE', routeConfidence: 0.99 }, band: 0.9 }).decision()).resolves.toMatchObject({ _tag: 'AgentTriage' })
    await expect(controller({ answers: { route: 'NEEDS_INFO', routeConfidence: 0.99, needsCodebaseReview: 0.8 }, band: 0.9 }).decision()).resolves.toMatchObject({ _tag: 'AgentTriage' })
  })

  it('publishes the routed comment and label on settle', async () => {
    const comments: string[] = []
    const labels: string[] = []
    const issue = issueItem()
    const instance = createIssueClassificationController({
      classification: classificationAnswer({ route: 'WAIT_TO_IMPLEMENT', routeConfidence: 0.95 }),
      band: 0.9,
      github: {
        getIssueTriageSnapshot: () => Promise.resolve(ok({ body: '', comments: [], state: 'open' as const, title: 't', updatedAt: '2026-09-18T00:00:00.000Z' })),
        stampAgentLabel: (_repository, _number, state) => {
          labels.push(state)
          return Promise.resolve(ok(undefined))
        },
        upsertIssueTriageComment: (_repository, _number, _commentId, body) => {
          comments.push(body)
          return Promise.resolve(ok({ commentId: 5, url: 'u' }))
        },
      },
    })

    const decision = await instance.verdict(repositoryMapping(), issue, new AbortController().signal)
    if (decision._tag !== 'Routed')
      throw new Error('Expected a routed decision.')
    await expect(instance.settle(repositoryMapping(), issue, decision.result, new AbortController().signal)).resolves.toEqual(ok(undefined))
    expect(comments[0]).toContain('ISSUE TRIAGE')
    expect(comments[0]).toContain('Wait to implement')
    expect(labels).toEqual(['WAIT_TO_IMPLEMENT'])
  })
})

describe('issue triage classification in the journal', () => {
  it('records a routed decision and never queues the triage Task', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping({ issueWork: true })], '2026-09-18T00:00:00.000Z')
    const issue = issueItem()
    const inserted = store.recordObservation({
      externalId: 'issue-routed',
      observedAt: '2026-09-18T00:01:00.000Z',
      source: 'poll',
      subject: issue,
      issueTriage: {
        _tag: 'Routed',
        confidence: 0.95,
        title: 'Button does nothing',
        body: 'Steps: open the app.',
        result: routedResult({ route: 'NEEDS_INFO', difficulty: 2, impact: 3, hasReproduction: true }),
      },
    })
    if (inserted._tag !== 'Inserted')
      throw new Error('Expected one inserted Revision.')

    expect(store.claimNextIssueTriageTask('triager-1', '2026-09-18T00:02:00.000Z', 60_000)).toBeNull()
    const run = store.getLatestIssueTriageRun(issue.repository, issue.number, inserted.revisionId)
    expect(run).toMatchObject({ result: { _tag: 'NEEDS_INFO', difficulty: 2 }, confidence: 0.95 })
  })

  it('rebuilds a stored routed decision exactly as it settled', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping({ issueWork: true })], '2026-09-18T00:00:00.000Z')
    const issue = issueItem()
    const settled = routedResult({ route: 'NEEDS_INFO', difficulty: 2, impact: 3, hasReproduction: true })
    const inserted = store.recordObservation({
      externalId: 'issue-routed-rebuild',
      observedAt: '2026-09-18T00:01:00.000Z',
      source: 'poll',
      subject: issue,
      issueTriage: {
        _tag: 'Routed',
        confidence: 0.95,
        title: 'Button does nothing',
        body: 'Steps: open the app.',
        result: settled,
      },
    })
    if (inserted._tag !== 'Inserted')
      throw new Error('Expected one inserted Revision.')

    // The poll settles a stored route again, so the rebuilt result must
    // reproduce the settled comment byte for byte. A shorter rebuild would
    // rewrite the comment the first poll after it landed.
    const run = store.getLatestIssueTriageRun(issue.repository, issue.number, inserted.revisionId)
    expect(run).toMatchObject({ _tag: 'Routed' })
    if (run?._tag !== 'Routed')
      throw new Error('Expected a stored routed decision.')
    expect(run.result).toEqual(settled)
  })

  it('records an Agent-kept decision so the same Revision is never asked again', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping({ issueWork: true })], '2026-09-18T00:00:00.000Z')
    const issue = issueItem({ author: 'harlan-zw' })
    const inserted = store.recordObservation({
      externalId: 'issue-agent-kept',
      observedAt: '2026-09-18T00:01:00.000Z',
      source: 'poll',
      subject: issue,
      issueTriage: { _tag: 'AgentTriage', reason: 'The classification left the route to the Agent turn.' },
    })
    if (inserted._tag !== 'Inserted')
      throw new Error('Expected one inserted Revision.')

    const stored = store.getLatestIssueTriageRun(issue.repository, issue.number, inserted.revisionId)
    expect(stored).toMatchObject({ _tag: 'AgentTriage' })
    // The Agent-kept Revision still queues its Task.
    expect(store.claimNextIssueTriageTask('triager-1', '2026-09-18T00:02:00.000Z', 60_000)).not.toBeNull()
  })

  it('records a routed decision even when a triage Task is already queued', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping({ issueWork: true })], '2026-09-18T00:00:00.000Z')
    const issue = issueItem({ author: 'harlan-zw' })
    const first = store.recordObservation({
      externalId: 'issue-task-first',
      observedAt: '2026-09-18T00:01:00.000Z',
      source: 'poll',
      subject: issue,
    })
    if (first._tag !== 'Inserted')
      throw new Error('Expected one inserted Revision.')
    expect(store.claimNextIssueTriageTask('triager-1', '2026-09-18T00:01:30.000Z', 60_000)).not.toBeNull()

    const settled = routedResult({ route: 'NEEDS_INFO', difficulty: 2, impact: 3, hasReproduction: true })
    const second = store.recordObservation({
      externalId: 'issue-routed-later',
      observedAt: '2026-09-18T00:02:00.000Z',
      source: 'poll',
      subject: issue,
      issueTriage: {
        _tag: 'Routed',
        confidence: 0.95,
        title: 'Button does nothing',
        body: 'Steps: open the app.',
        result: settled,
      },
    })
    if (second._tag !== 'Duplicate')
      throw new Error('Expected the same Revision.')

    // The row is what makes the decision durable: without it, every later
    // poll re-asks the classification and re-settles the comment against a
    // task that may never answer.
    const run = store.getLatestIssueTriageRun(issue.repository, issue.number, second.revisionId)
    expect(run).toMatchObject({ _tag: 'Routed', confidence: 0.95 })
  })

  it('queues the triage Task for an Agent decision', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping({ issueWork: true })], '2026-09-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'issue-agent',
      observedAt: '2026-09-18T00:01:00.000Z',
      source: 'poll',
      subject: issueItem({ author: 'harlan-zw' }),
      issueTriage: { _tag: 'AgentTriage', reason: 'The classification left the route to the Agent turn.' },
    })

    expect(store.claimNextIssueTriageTask('triager-1', '2026-09-18T00:02:00.000Z', 60_000)).not.toBeNull()
  })
})

describe('issueRouteQuestions', () => {
  it('keeps its option order stable, because order moves the distribution', () => {
    expect(Object.keys(issueRouteQuestions().route.criteria)).toEqual([
      'NEEDS_INFO',
      'WAIT_TO_IMPLEMENT',
      'AGENT_TRIAGE',
    ])
  })

  it('offers the three routes with an untrusted-state note', () => {
    const questions = issueRouteQuestions()
    expect(questions.route.criteria).toEqual({
      NEEDS_INFO: expect.any(String),
      WAIT_TO_IMPLEMENT: expect.any(String),
      AGENT_TRIAGE: expect.any(String),
    })
    expect(questions.route.instructions).toContain('untrusted')
  })
})
