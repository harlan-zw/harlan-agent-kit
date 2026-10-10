import type { IssueClassificationDecision } from '../src/issue-classification.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentApp } from '../src/app.ts'
import { createControlClient } from '../src/control-client.ts'
import { routedResult } from '../src/issue-classification.ts'
import { openJournalStore } from '../src/store.ts'
import { issueItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
afterEach(() => stores.splice(0).forEach(store => store.close()))

function setup(author = 'harlan-zw', path = ':memory:', issueTriage?: IssueClassificationDecision) {
  const store = openJournalStore(path)
  stores.push(store)
  store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
  const observed = store.recordObservation({ externalId: 'issue', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject: issueItem({ author }), ...(issueTriage === undefined ? {} : { issueTriage }) })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected an issue Revision.')
  const request = { repository: 'harlan-zw/example', issueNumber: 12, revisionId: observed.revisionId, at: '2026-08-13T02:00:00.000Z' }
  return { store, request }
}

function finish(store: ReturnType<typeof openJournalStore>, route = 'NEEDS_INFO') {
  const task = store.claimNextIssueTriageTask('first', '2026-08-13T01:01:00.000Z', 60_000)
  if (task === null)
    throw new Error('Expected triage.')
  expect(store.completeWorkerTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: '2026-08-13T01:01:30.000Z', evidence: JSON.stringify({ _tag: route }) })).toBe(true)
  return task
}

describe('issue triage rerun', () => {
  it('finds an Issue Revision outside the latest 100 dashboard Items', () => {
    const { store, request } = setup()
    for (let number = 100; number < 201; number++) {
      store.recordObservation({ externalId: `newer-${number}`, observedAt: request.at, source: 'poll', subject: issueItem({ number, author: 'harlan-zw' }) })
    }
    expect(store.getDashboardSnapshot(request.at).items.some(item => item.number === 12)).toBe(false)
    expect(store.getOpenIssueStatus(request.repository, 12)).toEqual({ revisionId: request.revisionId, dismissed: false })
  })

  it('rejects a closed issue', () => {
    const { store, request } = setup()
    store.recordObservation({ externalId: 'closed', observedAt: request.at, source: 'poll', subject: issueItem({ author: 'harlan-zw', state: 'closed' }) })
    expect(store.getOpenIssueStatus(request.repository, 12)).toBeNull()
    expect(store.requestIssueTriageRerun(request)).toMatchObject({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } })
  })

  it('creates Agent triage when classification skipped the original Agent task', () => {
    const { store, request } = setup('harlan-zw', ':memory:', { _tag: 'Routed', result: routedResult({ route: 'NEEDS_INFO', difficulty: 1, impact: 2, hasReproduction: false }), confidence: 0.95, title: 'Needs info', body: 'Add a reproduction.' })
    expect(store.claimNextIssueTriageTask('first', request.at, 60_000)).toBeNull()
    const queued = store.requestIssueTriageRerun(request)
    expect(queued._tag).toBe('Queued')
    expect(store.claimNextIssueTriageTask('second', request.at, 60_000)).toMatchObject({ revisionId: request.revisionId })
  })

  it('retains the rerun through a Journal restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'triage-rerun-'))
    const path = join(directory, 'journal.sqlite')
    const { store, request } = setup('harlan-zw', path)
    const first = finish(store)
    expect(store.requestIssueTriageRerun(request)).toMatchObject({ _tag: 'Queued' })
    stores.splice(stores.indexOf(store), 1)
    store.close()
    const reopened = openJournalStore(path)
    try {
      expect(reopened.requestIssueTriageRerun(request)).toEqual({ _tag: 'AlreadyQueued', taskId: first.id })
      expect(reopened.claimNextIssueTriageTask('second', request.at, 60_000)).toMatchObject({ id: first.id, state: { fence: 2 } })
    }
    finally {
      reopened.close()
      rmSync(directory, { recursive: true })
    }
  })

  it('uses the authenticated HTTP boundary and refuses stale or malformed requests', async () => {
    const { store, request } = setup()
    const first = finish(store)
    const origin = 'https://agent.example.test'
    const app = createAgentApp({ store, allowedOrigin: origin, dashboardPassword: 'test-password-with-at-least-32-bytes', now: () => new Date(request.at) })
    const created = createControlClient({ baseUrl: origin, authentication: { _tag: 'Basic', password: 'test-password-with-at-least-32-bytes' }, fetch: async (input, init) => {
      const httpRequest = new Request(input, init)
      httpRequest.headers.set('host', new URL(origin).host)
      return app.request(httpRequest)
    } })
    if (created._tag === 'Err')
      throw new Error(created.error.message)
    expect(await created.value.issueStatus(request.repository, 12)).toEqual({ _tag: 'Ok', value: { revisionId: request.revisionId, dismissed: false } })
    expect(await created.value.rerunIssueTriage(request.repository, 12, 'f'.repeat(64))).toMatchObject({ _tag: 'Err', error: { _tag: 'HttpFailure', status: 409 } })
    expect(await created.value.rerunIssueTriage(request.repository, 12, 'latest')).toMatchObject({ _tag: 'Err', error: { _tag: 'HttpFailure', status: 400 } })
    const unauthenticated = await app.request(`${origin}/api/issues/rerun-triage`, { method: 'POST', body: JSON.stringify(request), headers: { origin, host: new URL(origin).host } })
    expect(unauthenticated.status).toBe(401)
    expect(await created.value.rerunIssueTriage(request.repository, 12, request.revisionId)).toEqual({ _tag: 'Ok', value: { _tag: 'Queued', taskId: first.id } })
    expect(await created.value.rerunIssueTriage(request.repository, 12, request.revisionId)).toEqual({ _tag: 'Ok', value: { _tag: 'AlreadyQueued', taskId: first.id } })
    expect(store.claimNextIssueTriageTask('second', request.at, 60_000)).toMatchObject({ id: first.id, state: { fence: 2 } })
  })

  it.each(['paused', 'disabled'])('rejects a %s repository', (state) => {
    const { store, request } = setup()
    if (state === 'paused')
      store.setRepositoryPaused(request.repository, true)
    else store.syncRepositories([repositoryMapping({ enabled: false })], request.at)
    expect(store.requestIssueTriageRerun(request)).toMatchObject({ _tag: 'Rejected', reason: { _tag: 'NotAuthorized' } })
  })

  it('replaces a classification route with durable Agent triage', () => {
    const { store, request } = setup()
    const classification = { _tag: 'Routed' as const, result: routedResult({ route: 'NEEDS_INFO', difficulty: 1, impact: 2, hasReproduction: false }), confidence: 0.95, title: 'Needs info', body: 'Add a reproduction.' }
    store.recordObservation({ externalId: 'classified', observedAt: request.at, source: 'poll', subject: issueItem({ author: 'harlan-zw' }), issueTriage: classification })
    const first = finish(store)
    expect(store.requestIssueTriageRerun(request)).toEqual({ _tag: 'Queued', taskId: first.id })
    expect(store.getLatestIssueTriageRun(request.repository, 12, request.revisionId)).toMatchObject({ _tag: 'AgentTriage' })
    store.recordObservation({ externalId: 'classified-again', observedAt: request.at, source: 'poll', subject: issueItem({ author: 'harlan-zw' }), issueTriage: classification })
    expect(store.getLatestIssueTriageRun(request.repository, 12, request.revisionId)).toMatchObject({ _tag: 'AgentTriage' })
    expect(store.claimNextIssueTriageTask('second', request.at, 60_000)).toMatchObject({ id: first.id })
  })

  it('queues fresh triage for a completed revision without changing the issue', () => {
    const { store, request } = setup()
    const first = finish(store)
    expect(store.requestIssueTriageRerun(request)).toEqual({ _tag: 'Queued', taskId: first.id })
    expect(store.getIssueTriageEvidence(request.repository, request.issueNumber, request.revisionId)).toBeNull()
    expect(store.requestIssueTriageRerun(request)).toEqual({ _tag: 'AlreadyQueued', taskId: first.id })
    const fresh = store.claimNextIssueTriageTask('second', request.at, 60_000)
    expect(fresh).toMatchObject({ id: first.id, revisionId: request.revisionId, state: { fence: first.state.fence + 1 } })
    expect(store.claimNextIssueTriageTask('third', request.at, 60_000)).toBeNull()
    store.recordObservation({ externalId: 'same-issue', observedAt: request.at, source: 'poll', subject: issueItem({ author: 'harlan-zw' }) })
    expect(store.requestIssueTriageRerun(request)).toEqual({ _tag: 'AlreadyQueued', taskId: first.id })
  })

  it('rejects a stale revision without removing completed evidence', () => {
    const { store, request } = setup()
    finish(store)
    expect(store.requestIssueTriageRerun({ ...request, revisionId: 'f'.repeat(64) })).toMatchObject({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } })
    expect(store.getIssueTriageEvidence(request.repository, request.issueNumber, request.revisionId)).not.toBeNull()
    expect(store.claimNextIssueTriageTask('second', request.at, 60_000)).toBeNull()
  })

  it('preserves the outside contributor approval requirement', () => {
    const { store, request } = setup('contributor')
    expect(store.requestIssueTriageRerun(request)).toMatchObject({ _tag: 'Rejected', reason: { _tag: 'ApprovalRequired' } })
    expect(store.claimNextIssueTriageTask('second', request.at, 60_000)).toBeNull()
  })

  it('preserves an existing approval for the same Revision', () => {
    const { store, request } = setup('contributor')
    expect(store.approveIssue(request)).toMatchObject({ _tag: 'Approved', work: 'issue_triage' })
    const first = finish(store)
    expect(store.requestIssueTriageRerun(request)).toEqual({ _tag: 'Queued', taskId: first.id })
    expect(store.claimNextIssueTriageTask('second', request.at, 60_000)).toMatchObject({ id: first.id, state: { fence: 2 } })
  })

  it('rejects a dismissed issue', () => {
    const { store, request } = setup()
    finish(store)
    store.dismissItem({ repository: request.repository, itemNumber: 12, at: request.at })
    expect(store.requestIssueTriageRerun(request)).toMatchObject({ _tag: 'Rejected', reason: { _tag: 'Dismissed' } })
  })

  it('rejects active implementation', () => {
    const { store, request } = setup()
    finish(store, 'READY_TO_IMPLEMENT')
    expect(store.requestIssueTriageRerun(request)).toMatchObject({ _tag: 'Rejected', reason: { _tag: 'WorkActive' } })
  })
})
