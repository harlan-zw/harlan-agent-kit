import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentApp } from '../src/app.ts'
import { createApprovalController } from '../src/approval-controller.ts'
import { ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { dashboardSnapshot, pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []
const directories: string[] = []

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
})

function createStore(path = ':memory:') {
  const store = openJournalStore(path)
  stores.push(store)
  return store
}

/** One clean pull request from an author who can write here, so only the mode gates it. */
function observePullRequest(store: ReturnType<typeof openJournalStore>) {
  store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
  const observed = store.recordObservation({
    externalId: 'selection-observation',
    observedAt: '2026-08-13T01:00:00.000Z',
    source: 'poll',
    subject: pullRequestItem({ author: 'harlan-zw', mergeState: 'clean' }),
  })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected the pull request to be recorded.')
  return observed.revisionId
}

describe('selection mode', () => {
  it('starts in Auto', () => {
    expect(createStore().getSelectionMode()).toBe('auto')
  })

  it('reviews a trusted author pull request without Approval in Auto', () => {
    const store = createStore()
    observePullRequest(store)
    expect(store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:01:00.000Z', 10_000)).not.toBeNull()
  })

  it('holds a trusted author pull request for selection in Manual', () => {
    const store = createStore()
    store.setSelectionMode('manual')
    observePullRequest(store)
    expect(store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:01:00.000Z', 10_000)).toBeNull()
  })

  it('asks for the pull request in the Queue in Manual', () => {
    const store = createStore()
    store.setSelectionMode('manual')
    observePullRequest(store)
    const snapshot = store.getDashboardSnapshot('2026-08-13T01:01:00.000Z')
    expect(snapshot.selectionMode).toBe('manual')
    expect(snapshot.queue.map(entry => entry.state)).toEqual([{ _tag: 'AwaitingApproval', kind: 'review' }])
  })

  it('reviews the pull request once it is selected in Manual', () => {
    const store = createStore()
    store.setSelectionMode('manual')
    const revisionId = observePullRequest(store)
    const approved = store.approvePullRequest({
      repository: repositoryMapping().github,
      pullRequestNumber: 24,
      revisionId,
      kind: 'review',
      at: '2026-08-13T01:01:00.000Z',
    })
    expect(approved._tag).toBe('Approved')
    expect(store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:02:00.000Z', 10_000)).not.toBeNull()
  })

  it('refuses a selection that Auto never needed', () => {
    const store = createStore()
    const revisionId = observePullRequest(store)
    expect(store.approvePullRequest({
      repository: repositoryMapping().github,
      pullRequestNumber: 24,
      revisionId,
      kind: 'review',
      at: '2026-08-13T01:01:00.000Z',
    })).toEqual({ _tag: 'Rejected', reason: { _tag: 'ApprovalNotRequired' } })
  })

  it('drops a queued review when Manual takes over, on the next observation', () => {
    const store = createStore()
    observePullRequest(store)
    store.setSelectionMode('manual')
    store.recordObservation({
      externalId: 'selection-observation',
      observedAt: '2026-08-13T01:05:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ author: 'harlan-zw', mergeState: 'clean' }),
    })
    expect(store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:06:00.000Z', 10_000)).toBeNull()
  })

  it('keeps the mode across a restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'selection-mode-'))
    directories.push(directory)
    const path = join(directory, 'state.sqlite')
    const first = openJournalStore(path)
    first.setSelectionMode('manual')
    first.close()

    const second = createStore(path)
    expect(second.getSelectionMode()).toBe('manual')
  })
})

describe('selection mode approval controller', () => {
  function controllerWith(mode: 'auto' | 'manual', approvalLabels: Array<'review'>, calls: string[], author = 'harlan-zw') {
    return createApprovalController({
      github: {
        consumeApprovalLabel: () => {
          calls.push('consume')
          return Promise.resolve(ok(undefined))
        },
        ensureApprovalLabel: () => {
          calls.push('ensure')
          return Promise.resolve(ok(undefined))
        },
        upsertReviewStatus: () => {
          calls.push('comment')
          return Promise.resolve(ok({ commentId: 1, url: 'url' }))
        },
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        approveIssueWork: () => { throw new Error('Unexpected issue Approval.') },
        isIssueWorkApprovalReady: () => false,
        recordApprovalPromptComment: () => true,
        getSelectionMode: () => mode,
        hasPullRequestApproval: () => false,
        approvePullRequest: () => {
          calls.push('approve')
          return { _tag: 'Approved', approval: { _tag: 'ReviewApproved', approvedAt: '2026-08-13T01:00:00.000Z' } }
        },
      },
    }).reconcile(
      repositoryMapping(),
      pullRequestItem({ author, approvalLabels }),
      'a'.repeat(64),
      new AbortController().signal,
    )
  }

  it('writes nothing at all for a pull request Harlan opened in Manual', async () => {
    const calls: string[] = []
    expect(await controllerWith('manual', [], calls)).toEqual(ok(undefined))
    expect(calls).toEqual([])
  })

  it('writes nothing for an outside contributor in Manual either', async () => {
    // Inviting an Approval used to comment on every open contributor pull
    // request as soon as a repository was tracked. The dashboard already offers
    // Review and repair, so Manual says nothing until Harlan selects one.
    const calls: string[] = []
    expect(await controllerWith('manual', [], calls, 'outside-contributor')).toEqual(ok(undefined))
    expect(calls).toEqual([])
  })

  it('still invites an outside contributor Approval in Auto', async () => {
    const calls: string[] = []
    expect(await controllerWith('auto', [], calls, 'outside-contributor')).toEqual(ok(undefined))
    expect(calls).toEqual(['ensure', 'comment'])
  })

  it('takes the label as the selection in Manual', async () => {
    const calls: string[] = []
    expect(await controllerWith('manual', ['review'], calls)).toEqual(ok(undefined))
    expect(calls).toEqual(['approve'])
  })
})

describe('selection mode route', () => {
  const allowedHost = 'harlan-github-agent.local'
  const dashboardPassword = 'test-password-with-at-least-32-bytes'
  const authorization = `Basic ${Buffer.from(`agent:${dashboardPassword}`).toString('base64')}`

  function createApp(recorded: string[]) {
    return createAgentApp({
      allowedHost,
      dashboardPassword,
      dashboardRoot: join(import.meta.dirname, 'fixtures', 'dashboard'),
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        cancelTask: () => ({ _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }),
        getDashboardSnapshot: () => dashboardSnapshot(),
        listReviewRuns: () => [],
        pauseAgents: (at: string) => ({ _tag: 'Paused' as const, pausedAt: at }),
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
        resumeAgents: () => ({ _tag: 'Running' as const }),
        selectAgent: selection => selection,
        setRepositoryPaused: () => true,
        setRepositoryWritesEnabled: () => true,
        dismissItem: () => ({ _tag: 'Dismissed' as const }),
        restoreItem: () => ({ _tag: 'Restored' as const }),
        setSelectionMode: (mode) => {
          recorded.push(mode)
          return mode
        },
      },
    })
  }

  function request(app: ReturnType<typeof createAgentApp>, body: unknown) {
    return app.request(`http://${allowedHost}/api/agents/selection-mode`, {
      method: 'POST',
      headers: { authorization, 'host': allowedHost, 'origin': `http://${allowedHost}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('stores the mode the dashboard sent', async () => {
    const recorded: string[] = []
    const response = await request(createApp(recorded), { mode: 'manual' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ selectionMode: 'manual' })
    expect(recorded).toEqual(['manual'])
  })

  it('refuses a mode it does not know', async () => {
    const recorded: string[] = []
    const response = await request(createApp(recorded), { mode: 'sometimes' })
    expect(response.status).toBe(400)
    expect(recorded).toEqual([])
  })
})
