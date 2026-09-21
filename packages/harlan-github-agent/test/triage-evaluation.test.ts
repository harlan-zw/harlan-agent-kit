import type { Questions, SystemOneResult } from 'advocaat'
import type { ClassificationSource } from '../src/classification.ts'
import type { TriageReplay } from '../src/triage-evaluation.ts'
import { describe, expect, it } from 'vitest'
import { replayTriage, suggestBand, summariseBand } from '../src/triage-evaluation.ts'

const file = (path: string) => ({ additions: 1, deletions: 0, path, previousFilename: null, status: 'modified' as const })

function classified(skip: boolean, confidence: number): ClassificationSource {
  return {
    classify: <Q extends Questions>() => Promise.resolve({
      _tag: 'Ok' as const,
      value: {
        model: 'jev-1.13.0',
        answers: { review: { type: 'choice', choice: skip ? 'ADVERSARIAL_REVIEW_SKIPPED' : 'ADVERSARIAL_REVIEW_REQUIRED', confidence, probabilities: {} } },
        usage: { input_tokens: 10, output_tokens: 0 },
      } as SystemOneResult<Q>,
    }),
  }
}

const unavailable: ClassificationSource = {
  classify: () => Promise.resolve({ _tag: 'Err' as const, error: { _tag: 'Unavailable' as const, message: 'down' } }),
}

describe('replayTriage', () => {
  it('answers a runtime path from the rule without the classification', async () => {
    await expect(replayTriage({
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      title: 'chore: deps',
      files: [file('src/deployment.ts')],
      stored: 'ReviewRequired',
    }, null)).resolves.toEqual({ _tag: 'RuleRequired' })
  })

  it('answers a prose path through the classification', async () => {
    await expect(replayTriage({
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      title: 'docs: fix a typo',
      files: [file('README.md')],
      stored: 'ReviewSkipped',
    }, classified(true, 0.93))).resolves.toEqual({ _tag: 'Classified', skip: true, confidence: 0.93 })
  })

  it('reads an unavailable service as no answer rather than a skip', async () => {
    await expect(replayTriage({
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      title: 'docs: fix a typo',
      files: [file('README.md')],
      stored: 'ReviewSkipped',
    }, null)).resolves.toEqual({ _tag: 'Unavailable' })
    await expect(replayTriage({
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      title: 'docs: fix a typo',
      files: [file('README.md')],
      stored: 'ReviewSkipped',
    }, unavailable)).resolves.toEqual({ _tag: 'Unavailable' })
  })
})

describe('summariseBand', () => {
  const rows: Array<{ replay: TriageReplay, stored: 'ReviewRequired' | 'ReviewSkipped' | 'ReviewRequiredAfterFailure' }> = [
    { replay: { _tag: 'RuleRequired' }, stored: 'ReviewRequired' },
    { replay: { _tag: 'Classified', skip: true, confidence: 0.95 }, stored: 'ReviewSkipped' },
    { replay: { _tag: 'Classified', skip: true, confidence: 0.55 }, stored: 'ReviewRequired' },
    { replay: { _tag: 'Classified', skip: false, confidence: 0.9 }, stored: 'ReviewRequired' },
  ]

  it('counts agreement, extra Reviews, and skips of read Reviews per band', () => {
    expect(summariseBand(rows, 0.5)).toEqual({ band: 0.5, agreed: 2, ruleRequired: 1, unavailable: 0, reviewsAdded: 0, skipsAdded: 1, skipPrecision: 0.5 })
    expect(summariseBand(rows, 0.9)).toEqual({ band: 0.9, agreed: 3, ruleRequired: 1, unavailable: 0, reviewsAdded: 0, skipsAdded: 0, skipPrecision: 1 })
  })

  it('counts a rule-required replay in its own bucket, because the rule can drift', () => {
    expect(summariseBand([
      { replay: { _tag: 'RuleRequired' }, stored: 'ReviewRequired' },
      { replay: { _tag: 'Classified', skip: true, confidence: 0.9 }, stored: 'ReviewSkipped' },
    ], 0.7)).toEqual({ band: 0.7, agreed: 1, ruleRequired: 1, unavailable: 0, reviewsAdded: 0, skipsAdded: 0, skipPrecision: 1 })
  })

  it('counts an unavailable replay nowhere, so a broken run cannot inflate agreement', () => {
    expect(summariseBand([
      { replay: { _tag: 'Unavailable' }, stored: 'ReviewSkipped' },
      { replay: { _tag: 'Unavailable' }, stored: 'ReviewRequired' },
      { replay: { _tag: 'Classified', skip: true, confidence: 0.9 }, stored: 'ReviewSkipped' },
    ], 0.7)).toEqual({ band: 0.7, agreed: 1, ruleRequired: 0, unavailable: 2, reviewsAdded: 0, skipsAdded: 0, skipPrecision: 1 })
  })

  it('counts an over-confident skip as an added Review, never a lost one', () => {
    expect(summariseBand([
      { replay: { _tag: 'Classified', skip: true, confidence: 0.99 }, stored: 'ReviewSkipped' },
      { replay: { _tag: 'Classified', skip: false, confidence: 0.6 }, stored: 'ReviewSkipped' },
    ], 0.7)).toEqual({ band: 0.7, agreed: 1, ruleRequired: 0, unavailable: 0, reviewsAdded: 1, skipsAdded: 0, skipPrecision: 1 })
  })
})

describe('suggestBand', () => {
  it('prefers the band that skips the most while skipping nothing Review read', () => {
    const rows: Array<{ replay: TriageReplay, stored: 'ReviewRequired' | 'ReviewSkipped' }> = [
      { replay: { _tag: 'Classified', skip: true, confidence: 0.99 }, stored: 'ReviewSkipped' },
      { replay: { _tag: 'Classified', skip: true, confidence: 0.65 }, stored: 'ReviewSkipped' },
      { replay: { _tag: 'Classified', skip: true, confidence: 0.55 }, stored: 'ReviewRequired' },
    ]
    expect(suggestBand(rows)).toMatchObject({ band: 0.6, skipsAdded: 0, agreed: 3 })
  })

  it('moves up a band when a lower one would skip what Review read', () => {
    const rows: Array<{ replay: TriageReplay, stored: 'ReviewRequired' | 'ReviewSkipped' }> = [
      { replay: { _tag: 'Classified', skip: true, confidence: 0.92 }, stored: 'ReviewRequired' },
      { replay: { _tag: 'Classified', skip: true, confidence: 0.55 }, stored: 'ReviewSkipped' },
    ]
    expect(suggestBand(rows)).toMatchObject({ band: 0.95, skipsAdded: 0, agreed: 1 })
  })

  it('names the tradeoff at the widest band when no band reaches zero lost Reviews', () => {
    const rows: Array<{ replay: TriageReplay, stored: 'ReviewRequired' | 'ReviewSkipped' }> = [
      { replay: { _tag: 'Classified', skip: true, confidence: 0.99 }, stored: 'ReviewRequired' },
      { replay: { _tag: 'Classified', skip: true, confidence: 0.98 }, stored: 'ReviewRequired' },
    ]
    const suggestion = suggestBand(rows)
    expect(suggestion.skipsAdded).toBe(2)
    expect(suggestion.agreed).toBe(0)
  })
})
