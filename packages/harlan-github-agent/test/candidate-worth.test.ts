import type { Questions, SystemOneResult } from 'advocaat'
import type { ClassificationSource } from '../src/classification.ts'
import { describe, expect, it } from 'vitest'
import { CANDIDATE_DROP_CONFIDENCE_FLOOR, candidateWorthQuestions, worthFiling } from '../src/routines/candidates.ts'

const candidate = {
  title: 'Dependency updates pending',
  target: 'package.json',
  claim: 'Three dependencies are behind their latest releases.',
  verification: 'pnpm outdated',
  estimatedChangedFiles: 2,
}

function answer(choice: 'FILE' | 'DROP', confidence: number): ClassificationSource {
  return {
    classify: <Q extends Questions>() => Promise.resolve({
      _tag: 'Ok' as const,
      value: {
        model: 'jev-1.13.0',
        answers: { worth: { type: 'choice', choice, confidence, probabilities: {} } },
        usage: { input_tokens: 10, output_tokens: 0 },
      } as SystemOneResult<Q>,
    }),
  }
}

function failure(): ClassificationSource {
  return { classify: () => Promise.resolve({ _tag: 'Err' as const, error: { _tag: 'Unavailable' as const, message: 'down' } }) }
}

describe('candidate worth gate', () => {
  it('files a candidate the classification clears', async () => {
    await expect(worthFiling({ classification: answer('FILE', 0.9), routineName: 'harlan-zw/example:dependency-updates', candidate })).resolves.toBe(true)
  })

  it('drops a candidate only on a confident no', async () => {
    await expect(worthFiling({ classification: answer('DROP', CANDIDATE_DROP_CONFIDENCE_FLOOR), routineName: 'r', candidate })).resolves.toBe(false)
    await expect(worthFiling({ classification: answer('DROP', 0.6), routineName: 'r', candidate })).resolves.toBe(true)
  })

  it('files a candidate when the classification fails', async () => {
    await expect(worthFiling({ classification: failure(), routineName: 'r', candidate })).resolves.toBe(true)
  })

  it('names the routine and the untrusted candidate in the question', () => {
    const questions = candidateWorthQuestions('harlan-zw/example:sentry-checkin')
    expect(questions.worth.instructions).toContain('harlan-zw/example:sentry-checkin')
    expect(questions.worth.instructions).toContain('untrusted')
    expect(Object.keys(questions.worth.criteria)).toEqual(['FILE', 'DROP'])
  })
})
