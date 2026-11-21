import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFindingThreadSyncController } from '../src/finding-thread-sync.ts'
import { refreshControllerGates, terminalComment } from '../src/item-agent.ts'
import { withLoggedFindingControls } from '../src/logged-finding-pickup.ts'
import { publishLoggedFindingPickups } from '../src/logged-finding-sweep.ts'
import { err, ok } from '../src/result.ts'
import { reviewFindingThreadBody } from '../src/review-finding-threads.ts'
import { refreshReviewGates } from '../src/review-gate-sweep.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'
import { githubPublicationFixture } from './github-publication-fixture.ts'

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
  nextAction: 'Preserve buffered bytes between chunks.',
  details: { fingerprint: 'f'.repeat(64), identity: 'buffered bytes', location: { path: 'src/parser.ts', line: 42 }, proof: 'A split sequence loses bytes.' },
}

function setup(findings = [finding], path = ':memory:', target: 'head' | 'after-merge' = 'after-merge') {
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
  const terminal = terminalComment(pullRequest.headSha, pullRequest.baseSha, gates, findings, 95, [], undefined, mapping.github)
  const body = target === 'head' ? store.decorateLoggedFindings(terminal, 'review') : withLoggedFindingControls(terminal, findings, [])
  store.recordReviewPublication({ id: 'publication', reviewRunId: 'review', body, at, result: { _tag: 'Published', githubCommentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' } })
  const request = { repository: mapping.github, pullRequestNumber: pullRequest.number, headSha: pullRequest.headSha, commentId: 42, requestedBy: 'harlan-zw', commentAuthor: 'harlan-github-agent[bot]', fingerprints: [finding.details.fingerprint], before: body, requestId: 'delivery', at }
  return { store, mapping, pullRequest, request, body }
}

describe('durable Logged finding pickup', () => {
  it.each(['head', 'base'] as const)('revokes a pending selection across a %s change and return', (change) => {
    const second = { ...finding, details: { ...finding.details, fingerprint: '9'.repeat(64) } }
    const { store, pullRequest, request } = setup([finding, second], ':memory:', 'head')
    expect(store.requestLoggedFindingPickup(request)).toBe(true)
    const running = store.claimNextReviewFixTask('repair', at, 60_000)!
    expect(store.requestLoggedFindingPickup({ ...request, fingerprints: [second.details.fingerprint] })).toBe(true)
    store.recordObservation({ externalId: 'away', observedAt: at, source: 'poll', subject: { ...pullRequest, ...(change === 'head' ? { headSha: 'd'.repeat(40) } : { baseRef: 'next' }) } })
    store.recordObservation({ externalId: 'return', observedAt: at, source: 'poll', subject: pullRequest })
    store.completeTask({ taskId: running.id, workerId: running.state.workerId, fence: running.state.fence, at, evidence: 'Settled.' })
    expect(store.claimNextReviewFixTask('stale-selection', at, 60_000)).toBeNull()
  })

  it.each(['Written', 'Failed'] as const)('retains an early signed inline selection when the sync ends %s', async (outcome) => {
    const second = { ...finding, details: { ...finding.details, fingerprint: '9'.repeat(64) } }
    const { store, pullRequest, request } = setup([finding, second], ':memory:', 'head')
    store.queueReviewFindingThreadSync('review', at)
    let posted = 0
    let accepted: boolean | undefined
    const controller = createFindingThreadSyncController({ store, workerId: 'threads', now: () => new Date(at), readPullRequest: async () => ok(pullRequest), controls: () => true, mirror: { report: () => {}, source: {
      listReviewFindingThreads: async () => ok([]),
      postReviewFindingComment: async (_mapping, _number, comment) => {
        if (posted++ === 0) {
          // GitHub accepted this comment before the controller receives its response.
          accepted = store.requestLoggedFindingPickup({ ...request, inline: true, commentId: 101, before: comment.body })
        }
        else if (outcome === 'Failed') {
          return err('GitHub rejected the second comment.')
        }
        return ok({ _tag: 'Posted', comment: { id: 100 + posted, body: comment.body } })
      },
      resolveReviewFindingThread: async () => ok(undefined),
    } } })
    expect(await controller.run(new AbortController().signal)).toMatchObject([{ outcome: { _tag: outcome } }])
    expect(accepted).toBe(true)
    expect(store.claimNextReviewFixTask('repair', at, 60_000)?.pickup?.finding).toEqual(finding)
    expect(store.claimNextReviewFixTask('duplicate', at, 60_000)).toBeNull()
  })

  it.each(['body', 'base', 'head'] as const)('rejects an unreceipted inline control with a changed %s', (change) => {
    const { store, pullRequest, request } = setup([finding], ':memory:', 'head')
    store.queueReviewFindingThreadSync('review', at)
    store.claimReviewFindingThreadSync('threads', at, 60_000)
    const before = reviewFindingThreadBody(finding, change === 'head' ? 'd'.repeat(40) : pullRequest.headSha, change === 'base' ? 'next' : pullRequest.baseRef)
    expect(store.requestLoggedFindingPickup({ ...request, inline: true, commentId: 101, before: change === 'body' ? `${before}\nForged scope` : before })).toBe(false)
    expect(store.claimNextReviewFixTask('repair', at, 60_000)).toBeNull()
  })

  it.each(['inline', 'disputed'] as const)('keeps the canonical Review stable after %s pickup processing', async (mode) => {
    const { store, mapping, pullRequest, request } = setup([finding], ':memory:', 'head')
    let clock = '2026-09-30T00:00:01.000Z'
    const snapshot = { pullRequest, body: '', comments: [], findingDiscussions: [], reviews: [], priorAutomatedReview: { _tag: 'None' as const }, checks: { _tag: 'Available' as const, checks: [] }, baseChecks: { _tag: 'Available' as const, checks: [] }, requiredChecks: { _tag: 'None' as const } }
    const passed = store.listReviewRuns(mapping.github, pullRequest.number)[0]!.gates
    const refreshed = refreshControllerGates(passed, snapshot, mapping, { reviewStartedAt: at, now: new Date(at) })
    const gates = mode === 'disputed' ? { ...refreshed.gates, ci: { _tag: 'Pending' as const, reason: 'CI is running.', evidence: [] } } : refreshed.gates
    const initialBody = store.decorateLoggedFindings(terminalComment(pullRequest.headSha, pullRequest.baseSha, gates, [finding], undefined, refreshed.reportedChecks, undefined, mapping.github), 'review')
    const staged = store.stageReviewGateStatus({ reviewRunId: 'review', repository: mapping.github, pullRequestNumber: pullRequest.number, revisionId: store.listReviewGateRefreshes()[0]!.revisionId, expectedHeadSha: pullRequest.headSha, gates, body: initialBody, desiredOutcome: mode === 'disputed' ? 'PENDING' : 'READY', at: clock })
    if (staged._tag === 'Rejected')
      throw new Error(staged.reason)
    const command = store.claimReviewStatus(staged.commandId, 'publisher', clock, 60_000)!
    store.completeReviewStatus({ commandId: command.id, workerId: command.workerId, fence: command.fence, at: clock, commentId: 42, url: `${pullRequest.url}#issuecomment-42` })
    const fixture = githubPublicationFixture({ body: command.body, mode: 'idempotent' })
    if (mode === 'inline') {
      store.queueReviewFindingThreadSync('review', clock)
      const sync = store.claimReviewFindingThreadSync('threads', clock, 60_000)!
      store.completeReviewFindingThreadSync(sync, clock, [{ fingerprint: finding.details.fingerprint, commentId: 101, body: reviewFindingThreadBody(finding, pullRequest.headSha, pullRequest.baseRef), resolved: false }])
    }
    else {
      expect(store.requestLoggedFindingPickup({ ...request, before: command.body })).toBe(true)
      const repair = store.claimNextReviewFixTask('repair', at, 60_000)!
      store.needsAttentionTask({ taskId: repair.id, workerId: repair.state.workerId, fence: repair.state.fence, at, reason: 'Disputed: the finding is false.', evidence: 'Verified the parser.' })
    }
    clock = '2026-09-30T00:00:02.000Z'
    const options = { store, repositories: [mapping], now: () => new Date(clock), workerId: 'publisher', github: fixture.source }
    expect(await publishLoggedFindingPickups(options, new AbortController().signal)).toEqual([])
    const writes = fixture.writes.filter(write => write.includes('comment')).length
    const gateOptions = { ...options, preflightRepair: async () => ok(undefined), github: { ...fixture.source, getPullRequestReviewSnapshot: async () => ok(snapshot) } }
    for (let index = 0; index < 2; index++) {
      const result = await refreshReviewGates(gateOptions, new AbortController().signal)
      expect(result).toMatchObject([{ _tag: 'Ok', value: { _tag: mode === 'disputed' && index === 0 ? 'PublicationQueued' : 'Unchanged' } }])
      if (mode === 'disputed' && index === 0) {
        const next = store.claimNextTerminalReviewStatus('publisher', clock, 60_000)!
        expect(next.body).toContain('Disputed: the finding is false.')
        expect(next.body).toContain('### 🤖 READY')
        await fixture.source.upsertReviewStatus(mapping, pullRequest.number, 42, next.body, true, new AbortController().signal)
        store.completeReviewStatus({ commandId: next.id, workerId: next.workerId, fence: next.fence, at: clock, commentId: 42, url: `${pullRequest.url}#issuecomment-42` })
      }
      expect(await publishLoggedFindingPickups(options, new AbortController().signal)).toEqual([])
    }
    expect(fixture.writes.filter(write => write.includes('comment'))).toHaveLength(writes + (mode === 'disputed' ? 1 : 0))
  })

  it('starts a selected finding on the open head and does not replay a delivery', () => {
    const { store, pullRequest, request } = setup([finding], ':memory:', 'head')
    expect(request.before).toContain('Selected findings run on this pull request.')
    expect(store.requestLoggedFindingPickup(request)).toBe(true)
    expect(store.requestLoggedFindingPickup(request)).toBe(true)
    const task = store.claimNextReviewFixTask('repair', at, 60_000)
    expect(task).toMatchObject({ pullRequest: { state: 'open', headSha: pullRequest.headSha }, pickup: { finding } })
    expect(store.claimNextReviewFixTask('duplicate', at, 60_000)).toBeNull()
  })

  it('keeps both fixed threads eligible for resolution after consecutive Repairs', () => {
    const second = { ...finding, summary: 'A second finding.', details: { ...finding.details, fingerprint: '9'.repeat(64) } }
    const { store, mapping, pullRequest, request } = setup([finding, second], ':memory:', 'head')
    expect(store.requestLoggedFindingPickup(request)).toBe(true)
    expect(store.requestLoggedFindingPickup({ ...request, at: '2026-09-30T00:00:01.000Z', fingerprints: [second.details.fingerprint] })).toBe(true)
    const gates = store.listReviewRuns(mapping.github, pullRequest.number)[0]!.gates
    let current = pullRequest
    for (const [index, item] of [finding, second].entries()) {
      const task = store.claimNextReviewFixTask('repair', at, 60_000)!
      expect(task).toMatchObject({ pullRequest: { headSha: current.headSha }, pickup: { finding: item } })
      const commitSha = (index === 0 ? 'd' : 'e').repeat(40)
      const staged = store.stagePublication({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        publication: {
          _tag: 'UpdatePullRequest',
          taskKind: 'review_fix',
          baseRef: 'main',
          pullRequestNumber: current.number,
          commitSha,
          baseSha: current.baseSha,
          expectedHeadSha: current.headSha,
          headRef: current.headRef,
          artifactRef: 'refs/harlan-github-agent/publications/repair',
          patchDigest: 'patch',
          changedFiles: 1,
        },
      })
      if (staged._tag !== 'Staged')
        throw new Error('Expected a staged Repair.')
      const publication = store.claimNextPublication('publisher', at, 60_000)!
      expect(store.completePublication({ commandId: publication.id, workerId: publication.workerId, fence: publication.fence, at, evidence: 'Pushed the verified fix.' })).toBe(true)
      expect(store.getRepairedHeadFindings(mapping.github, current.number, commitSha)).toEqual([item])
      current = { ...current, headSha: commitSha }
      const observed = store.recordObservation({ externalId: `fixed-head-${index}`, observedAt: at, source: 'poll', subject: current })
      if (observed._tag !== 'Inserted')
        throw new Error('Expected the repaired head.')
      const review = store.claimNextAdversarialReviewTask('reviewer', at, 60_000)!
      const reviewRunId = `review-after-fix-${index}`
      store.recordReviewRun({ id: reviewRunId, repository: mapping.github, pullRequestNumber: current.number, revisionId: observed.revisionId, headSha: commitSha, provider: 'codex', sessionId: 'session', model: 'model', agentVersion: 'version', skillDigest: 'c'.repeat(64), startedAt: at, completedAt: at, gates, findings: index === 0 ? [second] : [] })
      store.completeWorkerTask({ taskId: review.id, workerId: review.state.workerId, fence: review.state.fence, at, evidence: reviewRunId })
      store.recordReviewPublication({ id: `publication-after-fix-${index}`, reviewRunId, body: 'Review after the fix.', at, result: { _tag: 'Published', githubCommentId: 42, url: `${current.url}#issuecomment-42` } })
      store.queueReviewFindingThreadSync(reviewRunId, at)
    }
    expect(store.claimReviewFindingThreadSync('threads', at, 60_000)?.fixedFingerprints)
      .toEqual(expect.arrayContaining([finding.details.fingerprint, second.details.fingerprint]))
  })

  it('routes a published inline checkbox and keeps the unanchored finding in the summary', () => {
    const generic = { ...finding, summary: 'A generic finding.', details: { ...finding.details, fingerprint: 'e'.repeat(64) } }
    const { store, pullRequest, request } = setup([finding, generic], ':memory:', 'head')
    store.queueReviewFindingThreadSync('review', at)
    const sync = store.claimReviewFindingThreadSync('threads', at, 60_000)!
    const inline = { fingerprint: finding.details.fingerprint, commentId: 4_640_421_240, body: reviewFindingThreadBody(finding, pullRequest.headSha, pullRequest.baseRef), resolved: false }
    expect(store.completeReviewFindingThreadSync(sync, at, [inline])).toBe(true)
    const summary = store.claimLoggedFindingComment('publisher', at, 60_000)
    expect(summary?.body).toContain(generic.summary)
    expect(summary?.body).not.toContain(finding.summary)

    const click = { ...request, inline: true as const, commentId: inline.commentId, before: inline.body }
    expect(store.requestLoggedFindingPickup({ ...click, commentId: inline.commentId + 1 })).toBe(false)
    expect(store.requestLoggedFindingPickup(click)).toBe(true)
    expect(store.claimNextReviewFixTask('repair', at, 60_000)?.pickup).toEqual({ _tag: 'LoggedFinding', finding, target: 'head' })
  })

  it('dismisses a summary finding without queuing Repair', () => {
    const { store, request } = setup([finding], ':memory:', 'head')
    expect(store.requestLoggedFindingPickup({ ...request, fingerprints: [], dismissedFingerprints: [finding.details.fingerprint] })).toBe(true)
    expect(store.claimNextReviewFixTask('repair', at, 60_000)).toBeNull()
    expect(store.claimLoggedFindingComment('publisher', at, 60_000)?.body).toContain('Dismissed.')
  })

  it.each(['claim', 'writes', 'dismissed', 'cancelled', 'wrong-commit', 'crash', 'restart', 'paused', 'drain', 'policy', 'head', 'write-loss', 'transient', 'evidence', 'evidence-writes', 'evidence-dismissed', 'evidence-no-proof'])('recovers only the authorized retained repair: %s', (mode) => {
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
    if (!['claim', 'crash', 'restart', 'write-loss', 'transient', 'evidence', 'evidence-writes', 'evidence-dismissed', 'evidence-no-proof'].includes(mode)) {
      expect(target._tag).toBe('Err')
      return
    }
    if (target._tag === 'Err')
      throw new Error(target.error)
    const candidate = expect.objectContaining({ _tag: 'Plan', taskId: task.id, commitSha, repository: mapping.github, pullRequestNumber: pullRequest.number })
    expect(store.getDashboardSnapshot(at).repairRecoveryCandidates).toContainEqual(candidate)
    const recovered = store.claimRepairRecovery(target.value, 'recovery', at, 60_000)
    expect(recovered._tag).toBe('Ok')
    expect(store.claimRepairRecovery(target.value, 'duplicate', at, 60_000)._tag).toBe('Err')
    expect(store.getDashboardSnapshot(at).tasks.find(item => item.id === task.id)?.recoveryAttempts).toBe(0)
    expect(store.getDashboardSnapshot(at).repairRecoveryCandidates).toEqual([])
    if (mode.startsWith('evidence')) {
      if (recovered._tag === 'Err')
        throw new Error(recovered.error)
      expect(store.needsAttentionTask({ taskId: task.id, workerId: 'recovery', fence: recovered.value.state.fence, at, reason: 'The selected tests need current evidence.', evidence: mode === 'evidence-no-proof' ? 'No retained proof.' : JSON.stringify(target.value.proof) })).toBe(true)
      if (mode === 'evidence-writes')
        store.setRepositoryWritesEnabled(mapping.github, false)
      if (mode === 'evidence-dismissed')
        store.dismissItem({ repository: mapping.github, itemNumber: pullRequest.number, at })
      const retry = store.inspectRepairRecovery(task.id, commitSha)
      if (mode !== 'evidence') {
        expect(retry._tag).toBe('Err')
        return
      }
      expect(retry._tag).toBe('Ok')
      expect(store.getDashboardSnapshot(at).repairRecoveryCandidates).toContainEqual(candidate)
      if (retry._tag === 'Err')
        throw new Error(retry.error)
      expect(store.claimRepairRecovery({ ...retry.value, stateTag: 'Failed' }, 'stale-state', at, 60_000)._tag).toBe('Err')
      expect(store.claimRepairRecovery(retry.value, 'retry', at, 60_000)).toMatchObject({ _tag: 'Ok', value: { state: { _tag: 'Running', fence: recovered.value.state.fence + 1 } } })
      expect(store.claimRepairRecovery(retry.value, 'duplicate', at, 60_000)._tag).toBe('Err')
    }
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
      expect(store.getDashboardSnapshot(at).repairRecoveryCandidates).toContainEqual(candidate)
    }
    if (['restart', 'write-loss', 'transient'].includes(mode)) {
      expect(store.claimNextReviewFixTask('implementation', at, 60_000)).toBeNull()
      expect(store.inspectRepairRecovery(task.id, commitSha)).toMatchObject({ _tag: 'Ok', value: { proof: { commitSha, originalFence: task.state.fence } } })
      expect(store.getDashboardSnapshot(at).tasks.find(item => item.id === task.id)?.recoveryAttempts).toBe(0)
      expect(store.getDashboardSnapshot(at).repairRecoveryCandidates).toContainEqual(candidate)
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

it('hides verified obsolete retained Repair recovery without removing Task history', () => {
  const { store, pullRequest, request } = setup()
  store.requestLoggedFindingPickup(request)
  store.recordObservation({ externalId: 'resolved-recovery-merge', observedAt: at, source: 'poll', subject: { ...pullRequest, state: 'closed', mergedAt: at } })
  let task = store.claimNextReviewFixTask('repair', at, 60000)!
  const commitSha = 'c'.repeat(40)
  const reason = `Could not pin the repair artifact: Could not pin the publication artifact: fatal: invalid refspec '+${commitSha}:refs/harlan-github-agent/publications/${task.id}'`
  while (store.failTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at, reason }) === 'Retrying')
    task = store.claimNextReviewFixTask('repair', at, 60000)!
  const before = store.getDashboardSnapshot(at)
  expect(before.repairRecoveryCandidates).toMatchObject([{ taskId: task.id, commitSha }])
  const incident = store.listIncidents().find(value => value.scope._tag === 'Task' && value.scope.taskId === task.id)
  if (incident === undefined)
    throw new Error('Expected retained Repair incident.')
  expect(store.resolveIncident({ incidentId: incident.id, lastSeenAt: incident.lastSeenAt, evidence: 'Verified merged fix covers the retained patch.', at })).toEqual({ _tag: 'Ok', value: { _tag: 'Resolved' } })
  expect(store.getDashboardSnapshot(at).repairRecoveryCandidates).toEqual([])
  expect(store.getDashboardSnapshot(at).tasks).toEqual(before.tasks)
})
