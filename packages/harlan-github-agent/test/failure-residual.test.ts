import type { Questions, SystemOneResult } from 'advocaat'
import type { ClassificationSource } from '../src/classification.ts'
import type { CheckFailureSignal } from '../src/failure.ts'
import { describe, expect, it } from 'vitest'
import { CHECK_INFRASTRUCTURE_CONFIDENCE_FLOOR, checkFailureQuestions, classifyCheckFailureWithResidual } from '../src/failure.ts'

const signal: CheckFailureSignal = {
  name: 'test',
  conclusion: 'failure',
  runnerLost: false,
  logTail: ['Error: spawn ENOMEM', '    at ChildProcess.spawn (node:internal/child_process:521:17)'],
}

function infraAnswer(confidence: number): ClassificationSource {
  return {
    classify: <Q extends Questions>() => Promise.resolve({
      _tag: 'Ok' as const,
      value: {
        model: 'jev-1.13.0',
        answers: { cause: { type: 'choice', choice: 'Infrastructure', confidence, probabilities: {} } },
        usage: { input_tokens: 10, output_tokens: 0 },
      } as SystemOneResult<Q>,
    }),
  }
}

function repairableAnswer(): ClassificationSource {
  return {
    classify: <Q extends Questions>() => Promise.resolve({
      _tag: 'Ok' as const,
      value: {
        model: 'jev-1.13.0',
        answers: { cause: { type: 'choice', choice: 'Repairable', confidence: 0.9, probabilities: {} } },
        usage: { input_tokens: 10, output_tokens: 0 },
      } as SystemOneResult<Q>,
    }),
  }
}

function classificationFailure(): ClassificationSource {
  return { classify: () => Promise.resolve({ _tag: 'Err' as const, error: { _tag: 'Unavailable' as const, message: 'down' } }) }
}

describe('check failure residual classification', () => {
  it('keeps a pattern-named infrastructure answer without asking', async () => {
    let asked = false
    const classification: ClassificationSource = {
      classify: () => {
        asked = true
        return Promise.resolve({ _tag: 'Err' as const, error: { _tag: 'Unavailable' as const, message: 'unused' } })
      },
    }
    const classified = await classifyCheckFailureWithResidual({
      signal: { ...signal, logTail: ['##[error]The operation was canceled as planning was cancelled'] },
      classification,
    })
    expect(classified._tag).toBe('Infrastructure')
    expect(asked).toBe(false)
  })

  it('moves an unnamed check to infrastructure only on a confident answer', async () => {
    await expect(classifyCheckFailureWithResidual({ signal, classification: infraAnswer(CHECK_INFRASTRUCTURE_CONFIDENCE_FLOOR) })).resolves.toMatchObject({ _tag: 'Infrastructure' })
    await expect(classifyCheckFailureWithResidual({ signal, classification: infraAnswer(0.7) })).resolves.toEqual({ _tag: 'Repairable' })
  })

  it('keeps the repair when the service says repairable or fails', async () => {
    await expect(classifyCheckFailureWithResidual({ signal, classification: repairableAnswer() })).resolves.toEqual({ _tag: 'Repairable' })
    await expect(classifyCheckFailureWithResidual({ signal, classification: classificationFailure() })).resolves.toEqual({ _tag: 'Repairable' })
    await expect(classifyCheckFailureWithResidual({ signal, classification: null })).resolves.toEqual({ _tag: 'Repairable' })
  })

  it('never asks about a check with no readable log', async () => {
    let asked = false
    const classification: ClassificationSource = {
      classify: () => {
        asked = true
        return Promise.resolve({ _tag: 'Err' as const, error: { _tag: 'Aborted' as const } })
      },
    }
    await expect(classifyCheckFailureWithResidual({ signal: { ...signal, logTail: [] }, classification })).resolves.toEqual({ _tag: 'Repairable' })
    expect(asked).toBe(false)
  })

  it('names the check and both owners in the question', () => {
    const questions = checkFailureQuestions('build')
    expect(questions.cause.instructions).toContain('"build"')
    expect(Object.keys(questions.cause.criteria)).toEqual(['Repairable', 'Infrastructure'])
  })
})
