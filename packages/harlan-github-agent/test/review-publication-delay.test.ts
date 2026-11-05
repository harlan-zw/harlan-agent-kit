import type { JournalStore } from '../src/store.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitHubRateLimitGate } from '../src/github-rate-limit.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).reverse().forEach(dispose => dispose()))

const at = '2026-11-05T09:02:05.000Z'
const reset = '2026-11-05T09:55:42.000Z'
const beforeReset = '2026-11-05T09:55:41.999Z'

function terminal(store: JournalStore, number = 24) {
  const subject = pullRequestItem({ number, mergeState: 'clean' })
  store.recordObservation({ externalId: `pr-${number}`, observedAt: '2026-11-05T09:01:00.000Z', source: 'poll', subject })
  const task = store.claimNextAdversarialReviewTask('reviewer', '2026-11-05T09:02:00.000Z', 60_000)
  if (task === null)
    throw new Error('Expected a Review Task.')
  const gates = {
    merge: { _tag: 'Passed' as const, evidence: [] },
    review: { _tag: 'Passed' as const, evidence: [] },
    ci: { _tag: 'Passed' as const, evidence: [] },
  }
  const reviewRunId = `review-${number}`
  store.recordReviewRun({
    id: reviewRunId,
    repository: task.repository,
    pullRequestNumber: number,
    revisionId: task.revisionId,
    headSha: subject.headSha,
    provider: 'codex',
    sessionId: 'fixture',
    model: 'fixture',
    agentVersion: 'fixture',
    skillDigest: 'a'.repeat(64),
    startedAt: '2026-11-05T09:02:00.000Z',
    completedAt: '2026-11-05T09:02:01.000Z',
    gates,
    confidence: 96,
    findings: [],
  })
  const staged = store.stageReviewStatus({
    taskKind: 'adversarial_review',
    taskId: task.id,
    workerId: task.state.workerId,
    fence: task.state.fence,
    at: '2026-11-05T09:02:02.000Z',
    revisionId: task.revisionId,
    expectedHeadSha: subject.headSha,
    phase: 'terminal',
    body: '<!-- harlan-agent-kit:pr-triage -->\n### READY',
    reviewRunId,
    gates,
    desiredOutcome: 'READY',
  })
  if (staged._tag === 'Rejected')
    throw new Error(staged.reason)
  store.completeWorkerTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: '2026-11-05T09:02:03.000Z', evidence: 'review' })
  return staged.commandId
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'review-publication-delay-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'journal.sqlite')
  let store = openJournalStore(path)
  cleanup.push(() => store.close())
  store.syncRepositories([repositoryMapping()], '2026-11-05T09:00:00.000Z')
  return {
    store,
    reopen: (legacy = false) => {
      store.close()
      if (legacy) {
        const database = new DatabaseSync(path)
        database.exec('ALTER TABLE review_status_commands DROP COLUMN retry_at; PRAGMA user_version = 93;')
        database.close()
      }
      store = openJournalStore(path)
      return store
    },
  }
}

describe('review publication quota delays', () => {
  it('upgrades a pending command from version 93 and retains its authority', () => {
    const existing = fixture()
    const id = terminal(existing.store)
    const store = existing.reopen(true)
    const command = store.claimReviewStatus(id, 'publisher', at, 60_000)!
    expect(command).toMatchObject({ id, desiredOutcome: 'READY', fence: 1 })
    expect(store.deferReviewStatus({ commandId: id, workerId: command.workerId, fence: command.fence, at, reason: `The primary GitHub rate limit. Requests pause until ${reset}.` })).toBe(true)
    expect(store.claimNextTerminalReviewStatus('early', beforeReset, 60_000)).toBeNull()
    expect(store.claimNextTerminalReviewStatus('publisher', reset, 60_000)).toMatchObject({ id, fence: 2 })
  })

  it.each([
    { kind: 'Primary', claim: 'direct' },
    { kind: 'Primary', claim: 'scheduled' },
    { kind: 'Secondary', claim: 'direct' },
    { kind: 'Secondary', claim: 'scheduled' },
  ] as const)('persists a $kind hold and resumes through $claim claims', ({ kind, claim }) => {
    const fixtureStore = fixture()
    let store = fixtureStore.store
    const id = terminal(store)
    const command = store.claimNextTerminalReviewStatus('publisher', at, 60_000)!
    expect(command.id).toBe(id)
    expect(store.recordReviewStatusReceipt({ commandId: id, workerId: command.workerId, fence: command.fence, at, sink: 'comment', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })).toBe(true)
    const gate = createGitHubRateLimitGate({ now: () => new Date(at) })
    const tokens = gate.guard({
      getToken: () => { throw new Error('Unexpected credential request.') },
      invalidate: () => {},
    }, () => kind === 'Primary' ? { _tag: 'Installation', owner: 'harlan-zw' } : { _tag: 'User', login: 'fixture' })
    tokens.rateLimited!('harlan-zw/example', kind === 'Primary'
      ? { _tag: 'Primary', resetAt: new Date(reset) }
      : { _tag: 'Secondary', retryAfterSeconds: (Date.parse(reset) - Date.parse(at)) / 1000 })
    const reason = gate.active()[0]!
    expect(store.deferReviewStatus({ commandId: id, workerId: command.workerId, fence: command.fence, at, reason })).toBe(true)
    expect(store.claimReviewStatus(id, 'early', beforeReset, 60_000)).toBeNull()
    expect(store.claimNextTerminalReviewStatus('early', beforeReset, 60_000)).toBeNull()
    store = fixtureStore.reopen()
    expect(store.claimReviewStatus(id, 'early', beforeReset, 60_000)).toBeNull()
    expect(store.claimNextTerminalReviewStatus('early', beforeReset, 60_000)).toBeNull()

    const otherId = terminal(store, 25)
    const other = store.claimReviewStatus(otherId, 'other', at, 60_000)!
    expect(store.deferReviewStatus({ commandId: otherId, workerId: other.workerId, fence: other.fence, at: '2026-11-05T09:02:06.000Z', reason: 'GitHub timed out.' })).toBe(true)
    expect(store.claimNextTerminalReviewStatus('other', beforeReset, 60_000)?.id).toBe(otherId)
    const resumed = (claim === 'direct'
      ? store.claimReviewStatus(id, 'publisher', reset, 60_000)
      : store.claimNextTerminalReviewStatus('publisher', reset, 60_000))!
    expect(resumed).toMatchObject({ id, fence: command.fence + 1, commentId: 42, outcomeUnknown: true })
    expect(store.deferReviewStatus({ commandId: id, workerId: command.workerId, fence: command.fence, at: reset, reason })).toBe(false)
    expect(store.completeReviewStatus({ commandId: id, workerId: resumed.workerId, fence: resumed.fence, at: reset, commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })).toBe(true)
  })

  it.each([
    'GitHub timed out.',
    'Requests pause until 2026-11-05T09:55:42.000Z.',
    'The primary GitHub rate limit. Requests pause until invalid.',
    'The primary GitHub rate limit. Requests pause until 2026-02-30T09:55:42.000Z.',
    'The primary GitHub rate limit. Requests pause until 2026-11-05T09:00:00.000Z.',
  ])('keeps existing retry behavior without a future deadline: %s', (reason) => {
    const { store } = fixture()
    const id = terminal(store)
    const command = store.claimReviewStatus(id, 'publisher', at, 60_000)!
    expect(store.deferReviewStatus({ commandId: id, workerId: command.workerId, fence: command.fence, at, reason })).toBe(true)
    expect(store.claimReviewStatus(id, 'retry', at, 60_000)).toMatchObject({ id, fence: command.fence + 1 })
  })
})
