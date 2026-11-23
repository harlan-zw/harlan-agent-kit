import type { Questions, SystemOneResult } from 'advocaat'
import type { ClassificationSource } from '../src/classification.ts'
import type { IssueDiscussionRoute, RepositoryMapping } from '../src/types.ts'
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
  route: 'NEEDS_INFO' | 'WAIT_TO_IMPLEMENT' | 'DISCUSSION' | 'AGENT_TRIAGE'
  routeConfidence: number
  difficulty?: number
  impact?: number
  hasReproduction?: number
  needsCodebaseReview?: number
}

function classificationAnswer(answers: RouteAnswers, calls?: { count: number }): ClassificationSource {
  return {
    classify: <Q extends Questions>() => {
      if (calls !== undefined)
        calls.count += 1
      return answered<Q>(answers)
    },
  }
}

function answered<Q extends Questions>(answers: RouteAnswers) {
  return Promise.resolve({
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
  })
}

function controller(input: {
  answers: RouteAnswers
  band: number | null
  discussion?: IssueDiscussionRoute
  calls?: { count: number }
  comments?: string[]
  labels?: string[]
}) {
  const issue = issueItem()
  return {
    issue,
    decision: () => createIssueClassificationController({
      classification: classificationAnswer(input.answers, input.calls),
      band: input.band,
      discussion: input.discussion ?? { _tag: 'Off' },
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

  it('asks no classification while both the triage band and the Discussion route are off', async () => {
    const calls = { count: 0 }
    await expect(controller({ answers: { route: 'DISCUSSION', routeConfidence: 0.99 }, band: null, calls }).decision())
      .resolves
      .toMatchObject({ _tag: 'AgentTriage' })
    expect(calls.count).toBe(0)
  })

  it('asks the classification in shadow mode without a triage band and still keeps Agent triage', async () => {
    const calls = { count: 0 }
    const decision = await controller({
      answers: { route: 'DISCUSSION', routeConfidence: 0.953, needsCodebaseReview: 0.124 },
      band: null,
      discussion: { _tag: 'Shadow', band: 0.9 },
      calls,
    }).decision()

    expect(calls.count).toBe(1)
    expect(decision).toEqual({
      _tag: 'AgentTriage',
      reason: expect.any(String),
      reading: { mode: 'Shadow', band: 0.9, route: 'DISCUSSION', confidence: 0.95, needsCodebaseReview: 0.12, skipsTriage: true },
    })
  })

  it('never routes needs-info from the Discussion band alone', async () => {
    // A null triage band must keep every NEEDS_INFO and WAIT_TO_IMPLEMENT
    // route with the Agent, however confident, in either mode.
    for (const mode of ['Shadow', 'Live'] as const) {
      const comments: string[] = []
      const decision = await controller({
        answers: { route: 'NEEDS_INFO', routeConfidence: 0.99 },
        band: null,
        discussion: { _tag: mode, band: 0.9 },
        comments,
      }).decision()
      expect(decision).toMatchObject({ _tag: 'AgentTriage', reading: { route: 'NEEDS_INFO', skipsTriage: false } })
      expect(comments).toEqual([])
    }
  })

  it('skips Agent triage in live mode only for a confident discussion that needs no code', async () => {
    const live = { _tag: 'Live', band: 0.9 } as const
    const decision = await controller({ answers: { route: 'DISCUSSION', routeConfidence: 0.92, needsCodebaseReview: 0.2 }, band: null, discussion: live }).decision()
    expect(decision).toEqual({
      _tag: 'Discussion',
      reading: { mode: 'Live', band: 0.9, route: 'DISCUSSION', confidence: 0.92, needsCodebaseReview: 0.2, skipsTriage: true },
      title: 'Button does nothing',
      body: 'Steps: open the app. Nothing happens.',
    })

    for (const answers of [
      { route: 'DISCUSSION', routeConfidence: 0.89, needsCodebaseReview: 0.2 },
      { route: 'DISCUSSION', routeConfidence: 0.99, needsCodebaseReview: 0.5 },
      { route: 'AGENT_TRIAGE', routeConfidence: 0.99, needsCodebaseReview: 0.1 },
    ] as const) {
      await expect(controller({ answers, band: 0.9, discussion: live }).decision())
        .resolves
        .toMatchObject({ _tag: 'AgentTriage', reading: { mode: 'Live', skipsTriage: false } })
    }
  })

  it('keeps the triage band route beside the Discussion route', async () => {
    const decision = await controller({
      answers: { route: 'WAIT_TO_IMPLEMENT', routeConfidence: 0.95 },
      band: 0.9,
      discussion: { _tag: 'Live', band: 0.9 },
    }).decision()
    expect(decision).toMatchObject({
      _tag: 'Routed',
      result: { _tag: 'WAIT_TO_IMPLEMENT' },
      reading: { route: 'WAIT_TO_IMPLEMENT', skipsTriage: false },
    })
  })

  it('stamps only the Discussion label on settle, with no triage comment', async () => {
    const comments: string[] = []
    const labels: string[] = []
    const issue = issueItem()
    const instance = createIssueClassificationController({
      classification: classificationAnswer({ route: 'DISCUSSION', routeConfidence: 0.95 }),
      band: null,
      discussion: { _tag: 'Live', band: 0.9 },
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

    await expect(instance.settle(repositoryMapping(), issue, { _tag: 'DISCUSSION' }, new AbortController().signal)).resolves.toEqual(ok(undefined))
    expect(labels).toEqual(['DISCUSSION'])
    expect(comments).toEqual([])
  })

  it('publishes the routed comment and label on settle', async () => {
    const comments: string[] = []
    const labels: string[] = []
    const issue = issueItem()
    const instance = createIssueClassificationController({
      classification: classificationAnswer({ route: 'WAIT_TO_IMPLEMENT', routeConfidence: 0.95 }),
      band: 0.9,
      discussion: { _tag: 'Off' },
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
    expect(comments[0]).toContain('⚪ **Wait to implement**')
    expect(comments[0]).toContain('automated triage, not Harlan\'s commitment')
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

  it('records a live Discussion decision and never queues the triage Task', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping({ issueWork: true })], '2026-09-18T00:00:00.000Z')
    const issue = issueItem({ author: 'harlan-zw' })
    const inserted = store.recordObservation({
      externalId: 'issue-discussion-live',
      observedAt: '2026-09-18T00:01:00.000Z',
      source: 'poll',
      subject: issue,
      issueTriage: {
        _tag: 'Discussion',
        reading: { mode: 'Live', band: 0.9, route: 'DISCUSSION', confidence: 0.94, needsCodebaseReview: 0.1, skipsTriage: true },
        title: 'Should sitemaps support i18n?',
        body: 'Curious what you think.',
      },
    })
    if (inserted._tag !== 'Inserted')
      throw new Error('Expected one inserted Revision.')

    expect(store.claimNextIssueTriageTask('triager-1', '2026-09-18T00:02:00.000Z', 60_000)).toBeNull()
    expect(store.getLatestIssueTriageRun(issue.repository, issue.number, inserted.revisionId)).toMatchObject({ _tag: 'Discussion', confidence: 0.94 })
    expect(store.listWorkflowEvents({ stream: 'issue_triage_status' })).toMatchObject([
      { event: 'discussion_live', itemNumber: issue.number, revisionId: inserted.revisionId, to: 'DISCUSSION' },
    ])
  })

  it('counts one shadow reading per classified Revision and still queues Agent triage', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping({ issueWork: true })], '2026-09-18T00:00:00.000Z')
    const issue = issueItem({ author: 'harlan-zw' })
    const decision = {
      _tag: 'AgentTriage' as const,
      reason: 'The Issue triage band is not configured.',
      reading: { mode: 'Shadow' as const, band: 0.9, route: 'DISCUSSION' as const, confidence: 0.93, needsCodebaseReview: 0.12, skipsTriage: true },
    }
    const first = store.recordObservation({ externalId: 'issue-shadow-1', observedAt: '2026-09-18T00:01:00.000Z', source: 'poll', subject: issue, issueTriage: decision })
    const second = store.recordObservation({ externalId: 'issue-shadow-2', observedAt: '2026-09-18T00:02:00.000Z', source: 'poll', subject: issue, issueTriage: decision })
    if (first._tag !== 'Inserted' || second._tag !== 'Duplicate')
      throw new Error('Expected one Revision observed twice.')

    expect(store.claimNextIssueTriageTask('triager-1', '2026-09-18T00:03:00.000Z', 60_000)).not.toBeNull()
    const events = store.listWorkflowEvents({ stream: 'issue_triage_status' })
    expect(events).toMatchObject([{ event: 'discussion_shadow', repository: issue.repository, itemNumber: issue.number, to: 'DISCUSSION' }])
    expect(JSON.parse(events[0]?.reason ?? 'null')).toEqual({ confidence: 0.93, needsCodebaseReview: 0.12, band: 0.9, skipsTriage: true })
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
      'DISCUSSION',
      'AGENT_TRIAGE',
    ])
  })

  it('offers the four routes with an untrusted-state note', () => {
    const questions = issueRouteQuestions()
    expect(questions.route.criteria).toEqual({
      NEEDS_INFO: expect.any(String),
      WAIT_TO_IMPLEMENT: expect.any(String),
      DISCUSSION: expect.any(String),
      AGENT_TRIAGE: expect.any(String),
    })
    expect(questions.route.instructions).toContain('untrusted')
  })
})
