import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { terminalComment } from '../src/item-agent.ts'
import { publishLoggedFindingPickups } from '../src/logged-finding-sweep.ts'
import { ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
const directories: string[] = []
afterEach(() => {
  stores.splice(0).forEach(store => store.close())
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
})
const at = '2026-09-30T00:00:00.000Z'
const finding = {
  _tag: 'Logged' as const,
  impact: 40,
  summary: 'The parser drops buffered bytes.',
  details: { fingerprint: 'f'.repeat(64), identity: 'buffered bytes', location: { path: 'src/parser.ts', line: 42 }, proof: 'A split sequence loses bytes.' },
}

function setup(findings = [finding], path = ':memory:') {
  const store = openJournalStore(path, true)
  stores.push(store)
  const mapping = repositoryMapping({ ownership: 'maintained' })
  store.syncRepositories([mapping], at)
  store.setRepositoryWritesEnabled(mapping.github, true)
  const pullRequest = pullRequestItem({ mergeState: 'clean', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) })
  const observation = store.recordObservation({ externalId: 'open', observedAt: at, source: 'poll', subject: pullRequest })
  if (observation._tag !== 'Inserted')
    throw new Error('Expected a pull request.')
  const task = store.claimNextAdversarialReviewTask('reviewer', at, 60_000)
  if (task === null)
    throw new Error('Expected Review.')
  const gates = { merge: { _tag: 'Passed' as const, evidence: [] }, review: { _tag: 'Passed' as const, evidence: [] }, ci: { _tag: 'Passed' as const, evidence: [] } }
  store.recordReviewRun({ id: 'review', repository: mapping.github, pullRequestNumber: pullRequest.number, revisionId: observation.revisionId, headSha: pullRequest.headSha, provider: 'codex', sessionId: 'session', model: 'model', agentVersion: 'version', skillDigest: 'c'.repeat(64), startedAt: at, completedAt: at, gates, findings })
  store.completeWorkerTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at, evidence: 'review' })
  const body = store.decorateLoggedFindings(terminalComment(pullRequest.headSha, pullRequest.baseSha, gates, findings, 95, [], undefined, mapping.github), 'review')
  store.recordReviewPublication({ id: 'publication', reviewRunId: 'review', body, at, result: { _tag: 'Published', githubCommentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' } })
  const request = { repository: mapping.github, pullRequestNumber: pullRequest.number, headSha: pullRequest.headSha, commentId: 42, requestedBy: 'harlan-zw', commentAuthor: 'harlan-github-agent[bot]', fingerprints: [finding.details.fingerprint], before: body, requestId: 'delivery', at }
  return { store, mapping, pullRequest, request, body }
}

describe('durable Logged finding pickup', () => {
  it.each(['claim', 'writes', 'dismissed', 'cancelled', 'wrong-commit', 'crash', 'restart', 'paused', 'drain', 'policy', 'head', 'write-loss', 'transient'])('recovers only the authorized retained repair: %s', (mode) => {
    const { store, mapping, pullRequest, request } = setup()
    store.requestLoggedFindingPickup(request)
    store.recordObservation({ externalId: 'recovery-merge', observedAt: at, source: 'poll', subject: { ...pullRequest, state: 'closed', mergedAt: at } })
    let task = store.claimNextReviewFixTask('repair', at, 60_000)!
    const commitSha = 'c'.repeat(40)
    store.recordRepairReport({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at, summary: 'Keep parser input', checks: ['check passed'] })
    const reason = `Could not pin the repair artifact: Could not pin the publication artifact: fatal: invalid refspec '+${commitSha}:refs/harlan-github-agent/publications/${task.id}'`
    while (store.failTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at, reason }) === 'Retrying') {
      task = store.claimNextReviewFixTask('repair', at, 60_000)!
    }
    if (mode === 'writes')
      store.setRepositoryWritesEnabled(mapping.github, false)
    if (mode === 'dismissed')
      store.dismissItem({ repository: mapping.github, itemNumber: pullRequest.number, at })
    if (mode === 'cancelled')
      store.cancelTask({ taskId: task.id, at })
    if (mode === 'paused')
      store.pauseAgents(at)
    if (mode === 'drain')
      store.requestRestart({ id: 'restart', source: 'helper', operation: { _tag: 'Restart' }, at })
    if (mode === 'policy')
      store.syncRepositories([{ ...mapping, ownership: 'external' }], at)
    if (mode === 'head')
      store.recordObservation({ externalId: 'head-moved', observedAt: at, source: 'poll', subject: { ...task.pullRequest, headSha: 'e'.repeat(40) } })
    const target = store.inspectRepairRecovery(task.id, mode === 'wrong-commit' ? 'd'.repeat(40) : commitSha)
    if (!['claim', 'crash', 'restart', 'write-loss', 'transient'].includes(mode)) {
      expect(target._tag).toBe('Err')
      return
    }
    if (target._tag === 'Err')
      throw new Error(target.error)
    const recovered = store.claimRepairRecovery(target.value, 'recovery', at, 60_000)
    expect(recovered._tag).toBe('Ok')
    expect(store.claimRepairRecovery(target.value, 'duplicate', at, 60_000)._tag).toBe('Err')
    expect(store.getDashboardSnapshot(at).tasks.find(item => item.id === task.id)?.recoveryAttempts).toBe(0)
    if (mode === 'restart')
      store.recoverInterruptedAgentTasks(at)
    if (mode === 'write-loss' || mode === 'transient') {
      if (mode === 'write-loss')
        store.setRepositoryWritesEnabled(mapping.github, false)
      if (recovered._tag === 'Err')
        throw new Error(recovered.error)
      expect(store.failTask({ taskId: task.id, workerId: 'recovery', fence: recovered.value.state.fence, at, reason: 'HTTP 503. Service unavailable.' })).toBe('Failed')
      store.setRepositoryWritesEnabled(mapping.github, true)
      store.retryRecoverableWorkerFailures('2026-09-30T01:00:00.000Z')
    }
    if (mode === 'crash') {
      store.claimNextReviewFixTask('after-crash', '2026-09-30T00:02:00.000Z', 60_000)
      expect(store.getDashboardSnapshot(at).tasks.find(item => item.id === task.id)?.state._tag).toBe('Failed')
      const retry = store.inspectRepairRecovery(task.id, commitSha)
      expect(retry).toMatchObject({ _tag: 'Ok', value: { proof: { commitSha, originalFence: task.state.fence } } })
    }
    if (['restart', 'write-loss', 'transient'].includes(mode)) {
      expect(store.claimNextReviewFixTask('implementation', at, 60_000)).toBeNull()
      expect(store.inspectRepairRecovery(task.id, commitSha)).toMatchObject({ _tag: 'Ok', value: { proof: { commitSha, originalFence: task.state.fence } } })
      expect(store.getDashboardSnapshot(at).tasks.find(item => item.id === task.id)?.recoveryAttempts).toBe(0)
    }
  })
  it('queues only the selected finding after merge and shows its progress beside the finding', () => {
    const { store, pullRequest, request } = setup()
    expect(store.requestLoggedFindingPickup(request)).toBe(true)
    expect(store.requestLoggedFindingPickup(request)).toBe(true)
    expect(store.claimNextReviewFixTask('repair', at, 60_000)).toBeNull()
    const comment = store.claimLoggedFindingComment('publisher', at, 60_000)
    expect(comment?.body).toContain('Queued after merge.')
    expect(comment?.body).not.toContain('[ ]')
    if (comment === null)
      throw new Error('Expected progress.')
    expect(store.authorizeLoggedFindingComment(comment, at)).toBe(true)
    expect(store.completeLoggedFindingComment(comment, at)).toBe(true)
    store.recordObservation({ externalId: 'merge', observedAt: at, source: 'poll', subject: { ...pullRequest, state: 'closed', mergedAt: at } })
    const task = store.claimNextReviewFixTask('repair', at, 60_000)
    expect(task?.pickup?.finding).toEqual(finding)
    expect(store.claimNextReviewFixTask('duplicate', at, 60_000)).toBeNull()
  })

  it.each(['head', 'finding', 'comment', 'body', 'writes', 'retarget'])('rejects stale or unauthorized %s', (kind) => {
    const { store, mapping, pullRequest, request } = setup()
    if (kind === 'head')
      request.headSha = 'd'.repeat(40)
    if (kind === 'finding')
      request.fingerprints = ['d'.repeat(64)]
    if (kind === 'comment')
      request.commentId = 99
    if (kind === 'body')
      request.before += '\nForged scope'
    if (kind === 'writes')
      store.setRepositoryWritesEnabled(mapping.github, false)
    if (kind === 'retarget')
      store.recordObservation({ externalId: 'retarget', observedAt: at, source: 'poll', subject: { ...pullRequest, baseRef: 'next' } })
    expect(store.requestLoggedFindingPickup(request)).toBe(false)
    expect(store.claimNextReviewFixTask('repair', at, 60_000)).toBeNull()
  })

  it('does not start a selected finding after the source head changes', () => {
    const { store, pullRequest, request } = setup()
    expect(store.requestLoggedFindingPickup(request)).toBe(true)
    store.recordObservation({ externalId: 'changed-merge', observedAt: at, source: 'poll', subject: { ...pullRequest, headSha: 'd'.repeat(40), state: 'closed', mergedAt: at } })
    expect(store.claimNextReviewFixTask('repair', at, 60_000)).toBeNull()
  })
  it('runs each selected finding once and links its result beside the source finding', () => {
    const second = { ...finding, summary: 'The parser drops the last byte.', details: { ...finding.details, fingerprint: 'e'.repeat(64) } }
    const { store, pullRequest, request } = setup([finding, second])
    request.fingerprints = [finding.details.fingerprint, second.details.fingerprint]
    expect(store.requestLoggedFindingPickup(request)).toBe(true)
    store.recordObservation({ externalId: 'merged', observedAt: at, source: 'poll', subject: { ...pullRequest, state: 'closed', mergedAt: at } })
    const picked: string[] = []
    for (let index = 0; index < 2; index++) {
      const task = store.claimNextReviewFixTask('repair', at, 60_000)
      if (task?.pickup === undefined)
        throw new Error('Expected selected finding work.')
      picked.push(task.pickup.finding.details.fingerprint)
      expect(store.completeTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at, evidence: `Repair pull request: https://github.com/harlan-zw/example/pull/${25 + index}` })).toBe(true)
    }
    expect(picked.sort()).toEqual(request.fingerprints.sort())
    expect(store.claimNextReviewFixTask('duplicate', at, 60_000)).toBeNull()
    const comment = store.claimLoggedFindingComment('publisher', at, 60_000)
    expect(comment?.body).toContain('https://github.com/harlan-zw/example/pull/25')
    expect(comment?.body).toContain('https://github.com/harlan-zw/example/pull/26')
    expect(comment?.body).not.toContain('[ ]')
  })

  it('fences a comment write when the repository loses write permission', () => {
    const { store, mapping, request } = setup()
    store.requestLoggedFindingPickup(request)
    const comment = store.claimLoggedFindingComment('publisher', at, 60_000)
    if (comment === null)
      throw new Error('Expected progress.')
    store.setRepositoryWritesEnabled(mapping.github, false)
    expect(store.authorizeLoggedFindingComment(comment, at)).toBe(false)
  })
  it('publishes progress once and preserves the canonical Review body', async () => {
    const { store, mapping, request, body } = setup()
    store.requestLoggedFindingPickup(request)
    const writes: string[] = []
    const options = {
      store,
      repositories: [mapping],
      now: () => new Date(at),
      workerId: 'publisher',
      github: { editReviewStatus: async (_mapping: unknown, _number: number, _id: number, expectedBody: string, nextBody: string, _signal: AbortSignal, authorize?: () => unknown) => {
        expect(expectedBody).toBe(body)
        expect(authorize?.()).toEqual(ok(undefined))
        writes.push(nextBody)
        return ok({ _tag: 'Edited' as const, commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })
      } },
    }
    expect(await publishLoggedFindingPickups(options, new AbortController().signal)).toEqual([])
    expect(await publishLoggedFindingPickups(options, new AbortController().signal)).toEqual([])
    expect(writes).toEqual([expect.stringContaining('Queued after merge.')])
    expect(writes[0]).toContain('### 🤖 READY')
  })
  it('keeps a selection across restart and claims it once after merge', () => {
    const directory = mkdtempSync(join(tmpdir(), 'logged-finding-restart-'))
    directories.push(directory)
    const path = join(directory, 'journal.sqlite')
    const { store, pullRequest, request } = setup([finding], path)
    expect(store.requestLoggedFindingPickup(request)).toBe(true)
    stores.splice(stores.indexOf(store), 1)
    store.close()
    const restored = openJournalStore(path, true)
    stores.push(restored)
    restored.recordObservation({ externalId: 'merged-after-restart', observedAt: at, source: 'poll', subject: { ...pullRequest, state: 'closed', mergedAt: at } })
    expect(restored.claimNextReviewFixTask('repair', at, 60_000)?.pickup?.finding).toEqual(finding)
    expect(restored.claimNextReviewFixTask('duplicate', at, 60_000)).toBeNull()
  })
})
