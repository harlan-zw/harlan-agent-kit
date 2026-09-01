import { describe, expect, it } from 'vitest'
import { runPassStep } from '../src/poll-pass.ts'

function defects() {
  const reported: Array<{ step: string, reason: string }> = []
  return {
    reported,
    onDefect: (step: string, reason: string) => {
      reported.push({ step, reason })
    },
  }
}

describe('running one poll pass step', () => {
  it('answers with what the step returned', async () => {
    const { reported, onDefect } = defects()

    const result = await runPassStep('Review gate refresh', () => ['settled'], [], {
      onDefect,
      signal: new AbortController().signal,
    })

    expect(result).toEqual(['settled'])
    expect(reported).toEqual([])
  })

  it('answers with the fallback when the step throws, so the steps behind it still run', async () => {
    const { reported, onDefect } = defects()

    const result = await runPassStep('Review gate refresh', () => {
      throw new Error('UNIQUE constraint failed: review_status_commands.task_id')
    }, ['fallback'], { onDefect, signal: new AbortController().signal })

    expect(result).toEqual(['fallback'])
    expect(reported).toEqual([{
      step: 'Review gate refresh',
      reason: 'UNIQUE constraint failed: review_status_commands.task_id',
    }])
  })

  it('answers with the fallback when the step rejects', async () => {
    const { reported, onDefect } = defects()

    const result = await runPassStep('Queue position comments', async () => {
      throw new Error('The store is closed.')
    }, [], { onDefect, signal: new AbortController().signal })

    expect(result).toEqual([])
    expect(reported).toEqual([{ step: 'Queue position comments', reason: 'The store is closed.' }])
  })

  it('reports nothing for a step the shutdown aborted', async () => {
    const { reported, onDefect } = defects()
    const controller = new AbortController()
    controller.abort()

    const result = await runPassStep('Stopped review comments', () => {
      throw new Error('This operation was aborted')
    }, [], { onDefect, signal: controller.signal })

    expect(result).toEqual([])
    expect(reported).toEqual([])
  })
})
