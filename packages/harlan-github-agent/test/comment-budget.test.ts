import type { StoppedReview } from '../src/store.ts'
import type { ReviewFinding, ReviewGates } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { mergedFollowUpsIssue } from '../src/follow-up-issue.ts'
import { terminalComment } from '../src/item-agent.ts'
import { withLoggedFindingControls, withoutLoggedFindingControls } from '../src/logged-finding-pickup.ts'
import { stoppedReviewComment } from '../src/review-stop-sweep.ts'

// GitHub refuses a comment or an issue body longer than this, and a refused verdict never publishes.
const limit = 65_536
const repository = 'harlan-zw/example'
const headSha = 'a'.repeat(40)
const passed = { _tag: 'Passed' as const, evidence: [] }
const gates: ReviewGates = { merge: passed, review: passed, ci: passed }

function followUp(index: number, proof: string, scope: 'change' | 'existing' = 'existing', summary = `Follow-up ${index} drops a boundary case`): Extract<ReviewFinding, { _tag: 'Logged' }> {
  return {
    _tag: 'Logged',
    impact: 50 + (index % 30),
    summary,
    nextAction: `Handle boundary case ${index}.`,
    details: {
      fingerprint: index.toString(16).padStart(64, '0'),
      identity: `boundary-${index}`,
      location: { path: `src/module-${index}.ts`, line: index + 1 },
      proof,
      scope,
    },
  }
}

/** Twelve follow-ups whose titles and fixes fit easily, and whose proofs together run past the limit. */
const longProofs = Array.from({ length: 12 }, (_, index) => followUp(index, `Proof ${index}. ${'The boundary input reaches the unguarded branch. '.repeat(160)}`, index % 2 === 0 ? 'change' : 'existing'))

function verdict(findings: ReviewFinding[]): string {
  return terminalComment({ headSha, baseSha: 'c'.repeat(40), gates, findings, confidence: 90, reportedChecks: [], repository, baseRef: 'main', reviewedAt: '2026-11-23T15:03:00.000Z', commands: ['Rerun'] })
}

function decorated(findings: ReviewFinding[]): string {
  return withLoggedFindingControls(verdict(findings), findings, [], { controls: { _tag: 'Open', repairOnHead: true }, baseRef: 'main' })
}

describe('a verdict whose follow-up proofs run past GitHub\'s limit', () => {
  it('fits the limit after its controls are added, and keeps the verdict and every row', () => {
    const body = decorated(longProofs)

    expect(longProofs.reduce((total, finding) => total + finding.details.proof.length, 0)).toBeGreaterThan(limit)
    expect(body.length).toBeLessThanOrEqual(limit)
    expect(body).toContain('🟢 **Ready** · `90/100`')
    expect(body.split('\n').at(-1)).toMatch(/^<sub>.*`@harlan-agent rerun`<\/sub>$/)
    for (const finding of longProofs) {
      expect(body).toContain(`- \`${finding.impact}\` ${finding.summary}`)
      expect(body).toContain(`Fix: ${finding.nextAction}`)
      expect(body).toContain(`logged-finding: ${finding.details.fingerprint}`)
    }
    // Proofs fill the room that is left, in list order, and the comment says how many it left out.
    expect(body).toContain(longProofs[0]!.details.proof.trim())
    expect(body).toMatch(/<sub>\d+ proofs left out to fit GitHub's size limit\.<\/sub>/)
  })

  it('cuts a long Repair status under every row, and strips back to the source', () => {
    const source = verdict(longProofs)
    // A completed Repair's evidence can be a whole Agent summary.
    const statuses = longProofs.map(finding => ({ _tag: 'Repair' as const, fingerprint: finding.details.fingerprint, status: `Repair finished. ${'The summary goes on. '.repeat(100)}`, cancellable: true }))
    const body = withLoggedFindingControls(source, longProofs, statuses, { controls: { _tag: 'Open', repairOnHead: true }, baseRef: 'main' })

    expect(body.length).toBeLessThanOrEqual(limit)
    expect(body.match(/Dismiss this finding/g)).toHaveLength(longProofs.length)
    expect(withoutLoggedFindingControls(body)).toBe(source)
  })

  it('renders the same body twice', () => {
    expect(decorated(longProofs)).toBe(decorated(longProofs))
  })

  it('counts the follow-ups it cannot list when their titles alone overflow', () => {
    const many = Array.from({ length: 400 }, (_, index) => followUp(index, 'Short proof.', 'existing', `Follow-up ${index} ${'drops a boundary case '.repeat(8).trimEnd()}`))
    const body = decorated(many)

    expect(body.length).toBeLessThanOrEqual(limit)
    expect(body).toContain('🟢 **Ready** · `90/100`')
    expect(body).toContain(`- \`${many[0]!.impact}\` ${many[0]!.summary}`)
    expect(body).toMatch(/<sub>\d+ more follow-ups not listed to fit GitHub's size limit\.<\/sub>/)
  })

  it('keeps a Merged comment and the Merged issue within the limit', () => {
    const stopped: StoppedReview = {
      taskId: 'task',
      taskKind: 'adversarial_review',
      repository,
      pullRequestNumber: 24,
      revisionId: 'revision',
      headSha,
      baseRef: 'main',
      closureRevisionId: 'revision',
      currentHeadSha: headSha,
      currentBaseSha: 'c'.repeat(40),
      reason: null,
      disposition: { _tag: 'Merged' },
      commentId: 1,
      publishedBody: '',
      findings: longProofs,
    }
    const merged = withLoggedFindingControls(stoppedReviewComment(stopped, '2026-11-23T15:03:00.000Z', { _tag: 'Merged' }), longProofs, [], { controls: { _tag: 'Merged', headSha } })
    const issue = mergedFollowUpsIssue({ repository, pullRequestNumber: 24, headSha, findings: longProofs })

    for (const body of [merged, issue.body]) {
      expect(body.length).toBeLessThanOrEqual(limit)
      for (const finding of longProofs)
        expect(body).toContain(`- \`${finding.impact}\` ${finding.summary}`)
    }
    expect(merged).toContain(`<!-- logged-findings: ${headSha} -->`)
  })
})
