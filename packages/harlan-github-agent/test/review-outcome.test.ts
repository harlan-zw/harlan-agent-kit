import type { ReviewGates, ReviewGateState } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { reviewOutcome, terminalComment } from '../src/item-agent.ts'
import { withLoggedFindingControls } from '../src/logged-finding-pickup.ts'
import { reviewCheckRunUpdate } from '../src/review-check-run.ts'
import { automatedReviewHead, priorAutomatedReviewForHead } from '../src/review-comment.ts'

const passed: ReviewGateState = { _tag: 'Passed', evidence: [] }
const pending = (reason: string): ReviewGateState => ({ _tag: 'Pending', reason, evidence: [] })
const failed = (reason: string): ReviewGateState => ({ _tag: 'Failed', reason, evidence: [] })

function gates(overrides: Partial<ReviewGates> = {}): ReviewGates {
  return {
    merge: passed,
    review: passed,
    ci: passed,
    ...overrides,
  }
}

describe('reviewOutcome', () => {
  it('waits when a controller gate is pending', () => {
    expect(reviewOutcome(gates({ merge: pending('GitHub is computing mergeability.') }))).toBe('PENDING')
  })

  it('blocks when the review itself failed', () => {
    expect(reviewOutcome(gates({ review: failed('A material defect remains.') }))).toBe('BLOCKED')
  })

  it('blocks on red CI when the review did complete, and names CI as the only reason', () => {
    const failedCi = gates({ ci: failed('test failed.') })

    expect(reviewOutcome(failedCi)).toBe('BLOCKED')
    expect(terminalComment({ headSha: 'abc123', baseSha: 'base123', gates: failedCi, findings: [], confidence: undefined, reportedChecks: [] }))
      .toContain('🟠 **Blocked** · CI failed; the review itself passed')
  })

  it('reports READY when every gate passed', () => {
    expect(reviewOutcome(gates())).toBe('READY')
  })

  it('folds an 80-impact finding as a follow-up without an issue to fix', () => {
    const body = terminalComment({ headSha: 'abc123', baseSha: 'base123', gates: gates(), findings: [{
      _tag: 'Logged',
      impact: 80,
      summary: 'A rare empty state loses spacing.',
      details: {
        fingerprint: 'empty-spacing',
        identity: 'empty-spacing',
        location: { path: 'src/view.ts', line: 14 },
        proof: 'The empty list hides its gap.',
      },
    }], confidence: 95, reportedChecks: [], repository: 'harlan-zw/example' })

    expect(body).toContain('🟢 **Ready** · `95/100`')
    expect(body).toContain('<details><summary><b>1 follow-up</b> · none block merge</summary>')
    expect(body).toContain('- `80` A rare empty state loses spacing. · [`view.ts:14`](https://github.com/harlan-zw/example/blob/abc123/src/view.ts#L14)')
    expect(body).not.toContain('Fix:')
  })

  it('says what PENDING waits for, and never lists the gates', () => {
    const body = terminalComment({ headSha: 'abc123', baseSha: 'base123', gates: gates({ ci: pending('Base branch CI: deploy is still running.') }), findings: [], confidence: undefined, reportedChecks: [], ciCause: { _tag: 'BaseBranchFailed', check: 'deploy' } })

    expect(body).toContain('⚪ **Pending** · the review passed; the verdict waits for CI\n\n<sub>Base branch CI: deploy is still running.</sub>')
    expect(body).toContain('<!-- workflow-state: {"_tag":"Review","headSha":"abc123","baseSha":"base123","outcome":"PENDING"')
    expect(body).not.toContain('gate:')
    expect(body).not.toContain('relative-time')
  })

  it('says nothing more about a running check, because the merge box shows it', () => {
    const body = terminalComment({ headSha: 'abc123', baseSha: 'base123', gates: gates({ ci: pending('test is still running.') }), findings: [], confidence: undefined, reportedChecks: [], ciCause: { _tag: 'CheckRunning', check: 'test' } })

    expect(body).not.toContain('still running')
  })

  it.each(['owned', 'maintained'] as const)('keeps issues above the folded follow-ups on %s repositories', (ownership) => {
    const findings = [
      {
        _tag: 'Logged' as const,
        impact: 45,
        summary: 'The retry log omits a delay.',
        nextAction: 'Optional follow-up. Include the delay.',
        details: { fingerprint: 'a'.repeat(64), identity: 'retry log', location: { path: 'src/queue.ts', line: 5 }, proof: 'The log only records the attempt.' },
      },
      {
        _tag: 'Open' as const,
        impact: 85,
        summary: 'The queue can drop events.',
        nextAction: 'Preserve pending events.',
      },
    ]
    const body = terminalComment({ headSha: 'abc123', baseSha: 'base123', gates: gates({ review: failed('A defect remains.') }), findings, confidence: undefined, reportedChecks: [], repository: `harlan-zw/${ownership}`, commands: [] })
    const decorated = withLoggedFindingControls(body, findings, [])
    const summary = '<summary><b>1 follow-up</b> · none block merge</summary>'
    expect(decorated).toContain('🟠 **Blocked** · 1 issue to fix before merge')
    expect(decorated).toContain(summary)
    expect(decorated).not.toContain('Optional follow-up')
    expect(decorated.indexOf('The queue can drop events.')).toBeLessThan(decorated.indexOf(summary))
    expect(decorated.indexOf('Ask an agent to verify and fix this finding')).toBeLessThan(decorated.indexOf('</details>'))
  })

  it('links an issue to the reviewed code line', () => {
    const body = terminalComment({ headSha: 'abc123', baseSha: 'base123', gates: gates({ review: failed('A defect remains.') }), findings: [{
      _tag: 'Open',
      impact: 81,
      summary: 'The queue can drop events.',
      nextAction: 'Preserve pending events.',
      details: {
        fingerprint: 'queue-events',
        location: { path: 'src/queue worker.ts', line: 42 },
        proof: 'The queue resets before sending.',
        regressionTest: 'Send two events.',
      },
    }], confidence: undefined, reportedChecks: [], repository: 'harlan-zw/example' })

    expect(body).toContain('1. **The queue can drop events.** `81/100`  \n   [`queue worker.ts:42`](https://github.com/harlan-zw/example/blob/abc123/src/queue%20worker.ts#L42) · Fix: Preserve pending events.')
  })

  it('keeps the issue when its code path cannot form a safe link', () => {
    const body = terminalComment({ headSha: 'abc123', baseSha: 'base123', gates: gates({ review: failed('A defect remains.') }), findings: [{
      _tag: 'Open',
      summary: 'The queue can drop events.',
      nextAction: 'Preserve pending events.',
      details: {
        fingerprint: 'queue-events',
        location: { path: '../queue.ts', line: 42 },
        proof: 'The queue resets before sending.',
        regressionTest: 'Send two events.',
      },
    }], confidence: undefined, reportedChecks: [], repository: 'harlan-zw/example' })

    expect(body).toContain('1. **The queue can drop events.**  \n   Fix: Preserve pending events.')
    expect(body).not.toContain('](https://github.com/harlan-zw/example/blob')
  })

  it('counts follow-ups below 40/100 and never lists them', () => {
    const body = terminalComment({ headSha: 'abc123', baseSha: 'base123', gates: gates(), findings: [{
      _tag: 'Logged',
      impact: 39,
      summary: 'A comment has a typo.',
      details: { fingerprint: 'typo', identity: 'typo', location: { path: 'src/view.ts', line: 1 }, proof: 'The word is misspelled.' },
    }], confidence: 95, reportedChecks: [], repository: 'harlan-zw/example' })

    expect(body).toContain('<sub>1 note below 40/100 not shown.</sub>')
    expect(body).not.toContain('A comment has a typo.')
    expect(body).not.toContain('<details>')
  })

  it('prints a Merge risk only when a person must read the merge', () => {
    const contained = terminalComment({ headSha: 'abc123', baseSha: 'base123', gates: gates(), findings: [], confidence: 95, reportedChecks: [], mergeRisk: { _tag: 'Contained' } })
    const sensitive = terminalComment({ headSha: 'abc123', baseSha: 'base123', gates: gates(), findings: [], confidence: 95, reportedChecks: [], mergeRisk: { _tag: 'Sensitive', reason: 'A migration changes the journal.' } })

    expect(contained).not.toContain('Merge risk')
    expect(sensitive).toContain('🟢 **Ready** · `95/100`\n\nMerge risk: **Sensitive**. A migration changes the journal.')
  })

  it('says what the Review checked and did not, and falls back for a run recorded before the fields', () => {
    const input = { headSha: 'abc123', baseSha: 'base123', gates: gates(), findings: [], confidence: 95, reportedChecks: [], repository: 'harlan-zw/example' }
    expect(terminalComment({ ...input, checked: 'Checked timeline reads against dense windows.', notChecked: 'the dashboard in a browser' }))
      .toContain('🟢 **Ready** · \`95/100\`\n\nChecked: timeline reads against dense windows. Not checked: the dashboard in a browser.')
    expect(terminalComment({ ...input, checked: 'every changed file', notChecked: null })).toContain('Checked: every changed file.\n')
    // The Agent often starts its clause with a capital. A colon keeps that from reading as a typo.
    expect(terminalComment({ ...input, checked: 'The full base-to-head diff', notChecked: 'Live Worker startup' }))
      .toContain('Checked: The full base-to-head diff. Not checked: Live Worker startup.')
    expect(terminalComment({ ...input, checked: null, notChecked: null })).toContain('No issues found in [\`abc123\`](https://github.com/harlan-zw/example/commit/abc123).')
  })

  it('names what Repair fixed when this head answers a Repair', () => {
    const body = terminalComment({ headSha: 'abc123', baseSha: 'base123', gates: gates(), findings: [], confidence: 95, reportedChecks: [], repairedFrom: { headSha: 'eb2933b2d12adbdc25a9600668450b395bc55ff8', fingerprints: ['a'.repeat(64), 'b'.repeat(64)] } })
    expect(body).toContain('Repair fixed 2 issues from \`eb2933b\`.')
  })

  it('counts only the source issues the Review of the Repair cleared', () => {
    const surviving = {
      _tag: 'Logged' as const,
      impact: 60,
      summary: 'The cache never expires.',
      nextAction: 'Expire the cache.',
      details: { fingerprint: 'A'.repeat(64), identity: 'cache', location: { path: 'src/cache.ts', line: 3 }, proof: 'Entries stay forever.' },
    }
    const input = { headSha: 'abc123', baseSha: 'base123', gates: gates(), confidence: 95, reportedChecks: [], repository: 'harlan-zw/example' }
    const repairedFrom = { headSha: 'eb2933b2d12adbdc25a9600668450b395bc55ff8', fingerprints: ['a'.repeat(64), 'b'.repeat(64)] }

    // The Repair Review kept one source issue at a lower impact, so Repair fixed only the other.
    expect(terminalComment({ ...input, findings: [surviving], repairedFrom })).toContain('Repair fixed 1 issue from \`eb2933b\`.')
    // A Repair that fixed nothing says nothing.
    expect(terminalComment({ ...input, findings: [surviving, { ...surviving, details: { ...surviving.details, fingerprint: 'b'.repeat(64) } }], repairedFrom }))
      .not
      .toContain('Repair fixed')
  })

  it('carries the stored review time, so a re-render writes the same body', () => {
    const input = { headSha: 'abc123', baseSha: 'base123', gates: gates(), findings: [], confidence: 95, reportedChecks: [], reviewedAt: '2026-11-23T15:03:00.000Z' }
    expect(terminalComment(input)).toBe(terminalComment(input))
    expect(terminalComment(input)).toContain('<relative-time datetime="2026-11-23T15:03:00.000Z">')
  })
})

describe('terminalComment command line', () => {
  const headSha = 'a'.repeat(40)
  const both = ' · `@harlan-agent rerun` · `@harlan-agent <change>`</sub>'

  it('ends an owned pull request comment with both commands', () => {
    const body = terminalComment({ headSha, baseSha: 'base123', gates: gates(), findings: [], confidence: 95, reportedChecks: [], repository: 'harlan-zw/example', commands: ['Change', 'Rerun'] })

    expect(body.split('\n').at(-1)!.endsWith(both)).toBe(true)
  })

  it('ends a pull request that accepts only rerun with rerun alone', () => {
    const body = terminalComment({ headSha, baseSha: 'base123', gates: gates({ review: failed('A defect remains.') }), findings: [], confidence: undefined, reportedChecks: [], repository: 'acme/example', commands: ['Rerun'] })

    expect(body.split('\n').at(-1)!.endsWith(' · `@harlan-agent rerun`</sub>')).toBe(true)
    expect(body).not.toContain('<change>')
  })

  it('names no command when the pull request accepts none', () => {
    const body = terminalComment({ headSha, baseSha: 'base123', gates: gates(), findings: [], confidence: 95, reportedChecks: [], repository: 'acme/example', commands: [] })

    expect(body).not.toContain('@harlan-agent')
    expect(body).toBe(terminalComment({ headSha, baseSha: 'base123', gates: gates(), findings: [], confidence: 95, reportedChecks: [], repository: 'acme/example' }))
  })

  it('names no command while merge conflicts refuse every command', () => {
    const body = terminalComment({ headSha, baseSha: 'base123', gates: gates({ merge: failed('The pull request has merge conflicts.') }), findings: [], confidence: undefined, reportedChecks: [], repository: 'harlan-zw/example', commands: ['Change', 'Rerun'] })

    expect(body).not.toContain('@harlan-agent')
  })

  it('keeps every marker and parsed field whatever commands the footer names', () => {
    const plain = terminalComment({ headSha, baseSha: 'base123', gates: gates({ ci: pending('Base branch CI: deploy is still running.') }), findings: [], confidence: undefined, reportedChecks: [], repository: 'harlan-zw/example' })
    const body = terminalComment({ headSha, baseSha: 'base123', gates: gates({ ci: pending('Base branch CI: deploy is still running.') }), findings: [], confidence: undefined, reportedChecks: [], repository: 'harlan-zw/example', commands: ['Change', 'Rerun'] })

    expect(body.replace(both, '</sub>')).toBe(plain)
    expect(automatedReviewHead(body)).toBe(headSha)
    expect(reviewCheckRunUpdate({ taskKind: 'adversarial_review', phase: 'terminal', desiredOutcome: 'PENDING', body }, 'now'))
      .toEqual(reviewCheckRunUpdate({ taskKind: 'adversarial_review', phase: 'terminal', desiredOutcome: 'PENDING', body: plain }, 'now'))
    const comment = { authorAssociation: 'NONE', authorLogin: 'harlan-github-agent[bot]', body, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-1' }
    expect(priorAutomatedReviewForHead([comment], headSha, 'harlan-github-agent[bot]')).toEqual({ _tag: 'None' })
    const ready = terminalComment({ headSha, baseSha: 'base123', gates: gates(), findings: [], confidence: 95, reportedChecks: [], repository: 'harlan-zw/example', commands: ['Change', 'Rerun'] })
    expect(priorAutomatedReviewForHead([{ ...comment, body: ready }], headSha, 'harlan-github-agent[bot]'))
      .toEqual({ _tag: 'Found', authorLogin: 'harlan-github-agent[bot]', state: 'complete', url: comment.url })
  })
})
