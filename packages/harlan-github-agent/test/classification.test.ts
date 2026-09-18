import { APIError, choice, jev } from 'advocaat'
import { describe, expect, it } from 'vitest'
import { createClassificationSource } from '../src/classification.ts'

function sourceWith(fetch: typeof globalThis.fetch) {
  return createClassificationSource({
    client: jev({ accountId: 'acc', apiToken: 'token', fetch }),
  })
}

const questions = {
  review: choice('Decide.', {
    ADVERSARIAL_REVIEW_REQUIRED: 'Needs Review.',
    ADVERSARIAL_REVIEW_SKIPPED: 'Judgment free.',
  }),
}

describe('classification source', () => {
  it('returns the typed answers from the service', async () => {
    const source = sourceWith(async () => Response.json({
      model: 'jev-1.13.0',
      answers: {
        review: { type: 'choice', choice: 'ADVERSARIAL_REVIEW_SKIPPED', confidence: 0.93, probabilities: { ADVERSARIAL_REVIEW_REQUIRED: 0.07, ADVERSARIAL_REVIEW_SKIPPED: 0.93 } },
      },
      usage: { input_tokens: 25, output_tokens: 0 },
    }))

    const result = await source.classify({ state: { title: 'docs: fix a typo' }, questions })

    expect(result).toEqual(expect.objectContaining({
      _tag: 'Ok',
      value: expect.objectContaining({
        model: 'jev-1.13.0',
        answers: expect.objectContaining({
          review: expect.objectContaining({ choice: 'ADVERSARIAL_REVIEW_SKIPPED', confidence: 0.93 }),
        }),
      }),
    }))
  })

  it('maps a service failure to an Unavailable value', async () => {
    const source = sourceWith(async () => Response.json({ success: false, errors: [{ message: 'authentication invalid' }] }))

    const result = await source.classify({ state: null, questions })

    expect(result).toEqual({
      _tag: 'Err',
      error: { _tag: 'Unavailable', message: expect.stringContaining('authentication invalid') },
    })
  })

  it('maps a thrown APIError to an Unavailable value', async () => {
    const source = sourceWith(async () => {
      throw new APIError(500, { error: 'internal' })
    })

    const result = await source.classify({ state: null, questions })

    expect(result).toEqual({
      _tag: 'Err',
      error: { _tag: 'Unavailable', message: '500 internal' },
    })
  })

  it('maps a cancelled request to an Aborted value', async () => {
    const source = sourceWith(async () => {
      throw new DOMException('The request was cancelled.', 'AbortError')
    })

    const result = await source.classify({ state: null, questions })

    expect(result).toEqual({ _tag: 'Err', error: { _tag: 'Aborted' } })
  })
})
