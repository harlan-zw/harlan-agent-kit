import { describe, expect, it } from 'vitest'
import { REVIEW_CHECK_RUN_NAME, reviewCheckRunUpdate } from '../src/review-check-run.ts'

const headSha = '1031dc93dddca88266cb32a085c7b90dcd58ec23'

function reviewBody(headline: string): string {
  return `<!-- harlan-agent-kit:pr-triage -->
<!-- reviewed-sha: ${headSha} -->
${headline}

> Disclosure line.`
}

describe('review check run update', () => {
  it('mirrors the review comment headline as one running check', () => {
    const update = reviewCheckRunUpdate({
      taskKind: 'adversarial_review',
      phase: 'review',
      desiredOutcome: null,
      body: reviewBody('### 🤖 REVIEWING · 55% · Reviewing changed files'),
    })

    expect(update).toEqual({
      _tag: 'Running',
      title: '🤖 REVIEWING · 55% · Reviewing changed files',
    })
  })

  it('reports repair progress as one running check', () => {
    const update = reviewCheckRunUpdate({
      taskKind: 'review_fix',
      phase: 'repair',
      desiredOutcome: null,
      body: reviewBody('### 🤖 REPAIR · round 1 of 3 · 35% · Git worktree ready'),
    })

    expect(update?._tag).toBe('Running')
  })

  it.each(['BLOCKED', 'PENDING', 'WAITING', 'EXISTING', 'SKIPPED'] as const)(
    'completes a %s review as neutral, never failure',
    (desiredOutcome) => {
      const update = reviewCheckRunUpdate({
        taskKind: 'adversarial_review',
        phase: 'terminal',
        desiredOutcome,
        body: reviewBody(`### 🤖 ${desiredOutcome} · Adversarial review`),
      })

      expect(update).toEqual(expect.objectContaining({ _tag: 'Completed', conclusion: 'neutral' }))
    },
  )

  it('completes a READY review as success', () => {
    const update = reviewCheckRunUpdate({
      taskKind: 'adversarial_review',
      phase: 'terminal',
      desiredOutcome: 'READY',
      body: reviewBody('### 🤖 READY · Adversarial review'),
    })

    expect(update).toEqual(expect.objectContaining({ _tag: 'Completed', conclusion: 'success' }))
  })

  it('never writes a check for a trusted foreign review', () => {
    const update = reviewCheckRunUpdate({
      taskKind: 'existing_review',
      phase: 'terminal',
      desiredOutcome: 'READY',
      body: reviewBody('### 🤖 READY · Adversarial review'),
    })

    expect(update).toBe(null)
  })

  it('falls back to a plain title when the comment carries no headline', () => {
    const update = reviewCheckRunUpdate({
      taskKind: 'adversarial_review',
      phase: 'review',
      desiredOutcome: null,
      body: '<!-- harlan-agent-kit:pr-triage -->',
    })

    expect(update).toEqual({ _tag: 'Running', title: 'Review' })
  })

  it('caps a headline longer than GitHub allows', () => {
    const longHeadline = `### 🤖 REVIEWING · ${'x'.repeat(400)}`
    const update = reviewCheckRunUpdate({
      taskKind: 'adversarial_review',
      phase: 'review',
      desiredOutcome: null,
      body: reviewBody(longHeadline),
    })

    expect(update?._tag === 'Running' && update.title.length).toBeLessThanOrEqual(255)
  })

  it('names the check after the kit and its Review', () => {
    expect(REVIEW_CHECK_RUN_NAME).toBe('harlan-agent-kit / Review')
  })
})
