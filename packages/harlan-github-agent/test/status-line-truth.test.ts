import type { ReviewCheckRunUpdate } from '../src/review-check-run.ts'
import type { ReviewFindingThread, ReviewFindingThreadMirror } from '../src/review-finding-threads.ts'
import type { StoppedReview } from '../src/store.ts'
import type { ReviewFinding, ReviewGates } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { terminalComment } from '../src/item-agent.ts'
import { withLoggedFindingControls, withoutLoggedFindingControls } from '../src/logged-finding-pickup.ts'
import { ok } from '../src/result.ts'
import { mirrorReviewFindingThreads, resolvedThreadBody, reviewFindingThreadBody, reviewFindingThreadMarker } from '../src/review-finding-threads.ts'
import { publishStoppedReviews, stoppedReviewComment } from '../src/review-stop-sweep.ts'
import { repositoryMapping } from './fixtures.ts'

// Each case below is a comment that stated something false. The Status line
// exists to stop that, so each one pins the true sentence.
const repository = 'harlan-zw/example'
const reviewed = 'a'.repeat(40)
const merged = 'b'.repeat(40)
const passed = { _tag: 'Passed' as const, evidence: [] }
const gates: ReviewGates = { merge: passed, review: passed, ci: passed }
function followUp(impact: number, fingerprint = 'f'.repeat(64)): Extract<ReviewFinding, { _tag: 'Logged' }> {
  return {
    _tag: 'Logged',
    impact,
    summary: 'Finished bars disappear at a viewport boundary',
    nextAction: 'Query for span overlap with the viewport.',
    details: { fingerprint, identity: `bars-${impact}`, location: { path: 'src/timeline-store.ts', line: 83 }, proof: 'When a bar crosses the viewport edge, the query drops it.', scope: 'change' },
  }
}
const verdict = (head: string, commands = true) => terminalComment({ headSha: head, baseSha: 'c'.repeat(40), gates, findings: [], confidence: 90, reportedChecks: [], repository, commands: commands ? ['Change', 'Rerun'] : [], reviewedAt: '2026-11-23T15:03:00.000Z' })
function stopped(publishedBody: string, overrides: Partial<StoppedReview> = {}): StoppedReview {
  return {
    taskId: 'task',
    taskKind: 'adversarial_review',
    repository,
    pullRequestNumber: 24,
    revisionId: 'revision',
    headSha: reviewed,
    baseRef: 'main',
    closureRevisionId: 'revision',
    currentHeadSha: reviewed,
    currentBaseSha: 'c'.repeat(40),
    reason: null,
    disposition: { _tag: 'Merged' },
    commentId: 42,
    publishedBody,
    findings: [],
    ...overrides,
  }
}

describe('a merged pull request', () => {
  it('says it was reviewed only when the Review covered the merged commit', () => {
    expect(stoppedReviewComment(stopped(verdict(reviewed)), '2026-11-24T00:00:00.000Z', { _tag: 'Merged' }))
      .toContain('🟣 **Merged** · reviewed with no issues')
    const unreviewed = stoppedReviewComment(stopped(verdict(reviewed), { currentHeadSha: merged }), '2026-11-24T00:00:00.000Z', { _tag: 'Merged' })
    expect(unreviewed).not.toContain('reviewed with no issues')
    expect(unreviewed).toContain(`🟣 **Merged** · the merged commit [\`bbbbbbb\`](https://github.com/${repository}/commit/${merged}) has no review`)
  })

  it('names the reviewed commit its follow-ups came from when a later commit merged', () => {
    const body = stoppedReviewComment(stopped(verdict(reviewed), { currentHeadSha: merged, findings: [followUp(55)] }), '2026-11-24T00:00:00.000Z', { _tag: 'Merged' })
    expect(body).toContain(`🟣 **Merged** · 1 follow-up from the review of [\`aaaaaaa\`](https://github.com/${repository}/commit/${reviewed})`)
  })
})

describe('a closed pull request', () => {
  it('keeps the verdict and drops the commands a closed pull request refuses', () => {
    const body = stoppedReviewComment(stopped(verdict(reviewed)), '2026-11-24T00:00:00.000Z', { _tag: 'Closed' })
    expect(body).toContain('🟢 **Ready** · `90/100`')
    expect(body).not.toContain('@harlan-agent')
    expect(body.split('\n').at(-1)).toMatch(/automated review, not Harlan's; a person merges · \[AI policy\]\([^)]+\)<\/sub>$/)
  })

  it('drops the command sentence a verdict written before the Status line ends with', () => {
    // Frozen: a verdict body from before the Status line.
    const old = `<!-- harlan-agent-kit:pr-triage -->\n<!-- reviewed-sha: ${reviewed} -->\n<!-- workflow-state: {"_tag":"Review","headSha":"${reviewed}","baseSha":"base","outcome":"READY","gates":{"merge":"Passed","review":"Passed","ci":"Passed"}} -->\n### 🤖 READY · 90/100\n\n- **Merge gate:** Passed.\n\nComment \`@harlan-agent rerun\` to review this commit again.`
    const body = stoppedReviewComment(stopped(old), '2026-11-24T00:00:00.000Z', { _tag: 'Closed' })
    expect(body).toContain('### 🤖 READY · 90/100')
    expect(body).not.toContain('@harlan-agent')
  })

  it('settles the Review check run with the verdict it keeps', async () => {
    const checkRuns: ReviewCheckRunUpdate[] = []
    const review = stopped(verdict(reviewed), { disposition: { _tag: 'Closed' } })
    await publishStoppedReviews({
      github: {
        clearAgentLabels: () => Promise.resolve(ok(undefined)),
        getPullRequestReviewSnapshot: () => { throw new Error('A closed pull request needs no snapshot.') },
        editReviewStatus: (_repository, _number, commentId) => Promise.resolve(ok({ _tag: 'Edited', commentId, url: `https://github.com/${repository}/pull/24#issuecomment-${commentId}` })),
        upsertReviewCheckRun: (_repository, _headSha, update) => {
          checkRuns.push(update)
          return Promise.resolve(ok(undefined))
        },
      },
      now: () => new Date('2026-11-24T00:00:00.000Z'),
      reportCheckRun: () => undefined,
      repositories: [repositoryMapping()],
      store: {
        listStoppedReviews: () => [review],
        recordDeletedReviewComment: () => true,
        recordReviewClosure: () => true,
        recordStoppedReviewStatus: () => true,
      },
    }, new AbortController().signal)
    expect(checkRuns).toEqual([{ _tag: 'Completed', title: '🟢 Ready · 90/100', conclusion: 'success', completedAt: '2026-11-24T00:00:00.000Z' }])
  })
})

describe('a follow-up', () => {
  it('keeps its fix in the canonical row, because a finding outside the diff has no thread', () => {
    const body = terminalComment({ headSha: reviewed, baseSha: 'c'.repeat(40), gates, findings: [followUp(55)], confidence: 90, reportedChecks: [], repository })
    expect(body).toContain(`- \`55\` Finished bars disappear at a viewport boundary · [\`timeline-store.ts:83\`](https://github.com/${repository}/blob/${reviewed}/src/timeline-store.ts#L83)<br>When a bar crosses the viewport edge, the query drops it.<br>Fix: Query for span overlap with the viewport.`)
  })

  it('keeps a linked row when its thread opens beside the code, so the count the native review shows stays true', () => {
    const findings = [followUp(55)]
    const source = terminalComment({ headSha: reviewed, baseSha: 'c'.repeat(40), gates, findings, confidence: 90, reportedChecks: [], repository })
    const thread = `https://github.com/${repository}/pull/24#discussion_r4640421240`
    const decorated = withLoggedFindingControls(source, findings, [], { controls: { _tag: 'Open', repairOnHead: true }, baseRef: 'main', inline: new Map([[findings[0]!.details.fingerprint, thread]]) })

    expect(decorated).toContain('<b>1 follow-up</b> · none block merge')
    expect(decorated).toContain(`<br>Fix: Query for span overlap with the viewport.\n  [Open the thread beside the code](${thread}) <!-- logged-finding: ${'f'.repeat(64)} -->`)
    expect(decorated).not.toContain('Ask an agent to verify and fix this finding')
    expect(withoutLoggedFindingControls(decorated)).toBe(source)
    expect(withLoggedFindingControls(decorated, findings, [], { controls: { _tag: 'Open', repairOnHead: true }, baseRef: 'main', inline: new Map([[findings[0]!.details.fingerprint, thread]]) })).toBe(decorated)
  })
})

describe('a finding thread', () => {
  it('retires its pickup control once a rerun scores the finding below the floor', async () => {
    const fingerprint = 'e'.repeat(64)
    const edits: string[] = []
    const thread: ReviewFindingThread = { threadId: 'T1', fingerprint, resolved: false, comment: { id: 1, body: reviewFindingThreadBody(followUp(42, fingerprint), { headSha: reviewed, baseRef: 'main', repairOnHead: true }) } }
    expect(thread.comment!.body).toContain('Ask an agent to verify and fix this finding')
    const mirror: ReviewFindingThreadMirror = {
      source: {
        listReviewFindingThreads: () => Promise.resolve(ok([thread])),
        postReviewFindingComment: () => Promise.resolve(ok({ _tag: 'Posted' })),
        resolveReviewFindingThread: () => Promise.resolve(ok(undefined)),
        editReviewFindingComment: async (_repository, comment, body) => {
          edits.push(body)
          return ok({ ...comment, body })
        },
      },
      report: () => undefined,
    }
    await mirrorReviewFindingThreads(mirror, repositoryMapping(), 24, reviewed, [followUp(39, fingerprint)], new AbortController().signal, () => ok(undefined), 'open', { controls: { repairOnHead: true }, baseRef: 'main' })

    expect(edits).toHaveLength(1)
    expect(edits[0]).not.toContain('Ask an agent to verify and fix this finding')
  })

  it('stops saying a fixed finding blocks merge, and keeps its title readable', () => {
    const open: Extract<ReviewFinding, { _tag: 'Open' }> = {
      _tag: 'Open',
      impact: 86,
      summary: 'Draft saves skip approval when HOME is unset',
      nextAction: 'Fail closed when HOME is not absolute.',
      resolution: 'Repair',
      details: { fingerprint: 'b'.repeat(64), identity: 'home', location: { path: 'hooks/guard.sh', line: 30 }, proof: 'With HOME unset, the guard allows the write.', regressionTest: null },
    }
    const body = resolvedThreadBody(reviewFindingThreadBody(open as Parameters<typeof reviewFindingThreadBody>[0], { headSha: reviewed, repairOnHead: true }), open.details!.fingerprint, merged, `https://github.com/${repository}/commit/${merged}`)

    expect(body).toContain('~~Draft saves skip approval when HOME is unset~~ · `86/100`\n')
    expect(body).not.toContain('blocks merge')
    expect(reviewFindingThreadMarker(body)).toMatchObject({ summary: 'Draft saves skip approval when HOME is unset.' })
  })
})

describe('a passed Review of a Repair commit', () => {
  it('names what Repair fixed from the Repair\'s source Review', () => {
    const body = terminalComment({ headSha: merged, baseSha: 'c'.repeat(40), gates, findings: [], confidence: 90, reportedChecks: [], repository, repairedFrom: { headSha: reviewed, fingerprints: ['a'.repeat(64), 'b'.repeat(64)] } })
    expect(body).toContain(`🟢 **Ready** · \`90/100\`\n\nRepair fixed 2 issues from \`aaaaaaa\`.`)
  })
})

describe('a follow-up without a thread', () => {
  it('keeps its proof beside its fix in the canonical row', () => {
    const body = terminalComment({ headSha: reviewed, baseSha: 'c'.repeat(40), gates, findings: [followUp(55)], confidence: 90, reportedChecks: [], repository })
    expect(body).toContain(`#L83)<br>When a bar crosses the viewport edge, the query drops it.<br>Fix: Query for span overlap with the viewport.`)
  })
})

describe('a promoted finding', () => {
  it('rewrites its thread as an issue that blocks merge, without the follow-up control', async () => {
    const fingerprint = 'd'.repeat(64)
    const edits: string[] = []
    const logged = followUp(55, fingerprint)
    const thread: ReviewFindingThread = { threadId: 'T1', fingerprint, resolved: false, comment: { id: 1, body: reviewFindingThreadBody(logged, { headSha: reviewed, baseRef: 'main', repairOnHead: true }) } }
    const promoted: Extract<ReviewFinding, { _tag: 'Open' }> = {
      _tag: 'Open',
      impact: 86,
      summary: logged.summary,
      nextAction: 'Query for span overlap with the viewport.',
      resolution: 'Repair',
      details: { fingerprint, identity: logged.details.identity, location: logged.details.location, proof: logged.details.proof, regressionTest: 'Cross the edge and assert the bar stays.' },
    }
    const mirror: ReviewFindingThreadMirror = {
      source: {
        listReviewFindingThreads: () => Promise.resolve(ok([thread])),
        postReviewFindingComment: () => Promise.resolve(ok({ _tag: 'Posted' })),
        resolveReviewFindingThread: () => Promise.resolve(ok(undefined)),
        editReviewFindingComment: async (_repository, comment, body) => {
          edits.push(body)
          return ok({ ...comment, body })
        },
      },
      report: () => undefined,
    }
    await mirrorReviewFindingThreads(mirror, repositoryMapping(), 24, reviewed, [promoted], new AbortController().signal, () => ok(undefined), 'open', { controls: { repairOnHead: true }, baseRef: 'main', repairStatus: 'Active' })

    expect(edits).toHaveLength(1)
    expect(edits[0]).toContain('🟠 **Finished bars disappear at a viewport boundary** · `86/100` · blocks merge')
    expect(edits[0]).not.toContain('does not block merge')
    expect(edits[0]).not.toContain('Ask an agent to verify and fix this finding')
    expect(edits[0]).toContain('⚪ Repair is fixing this.')
    expect(reviewFindingThreadMarker(edits[0]!)).toMatchObject({ fingerprint, logged: false })
  })
})
