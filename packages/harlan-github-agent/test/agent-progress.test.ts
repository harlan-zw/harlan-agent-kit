import type { AgentEvent } from '../src/agent-provider.ts'
import { describe, expect, it } from 'vitest'
import { advancedPhase, agentEventPhase, agentPhase } from '../src/agent-progress.ts'

describe('agentEventPhase', () => {
  it('uses the phase the agent reported instead of guessing from its commands', () => {
    const event: AgentEvent = { _tag: 'Progress', percent: 50, text: 'disproving the cache invalidation' }

    expect(agentEventPhase(event, 'review')).toEqual({
      _tag: 'Reported',
      // Halfway through the turn, which the turn's own band places at 60.
      percent: 60,
      label: 'disproving the cache invalidation',
    })
  })

  it('keeps a self-reported phase inside the turn band', () => {
    expect(agentEventPhase({ _tag: 'Progress', percent: 0, text: 'starting' }, 'review')?.percent).toBe(35)
    expect(agentEventPhase({ _tag: 'Progress', percent: 100, text: 'done' }, 'review')?.percent).toBe(85)
  })

  it('ignores a self-reported phase with no words in it', () => {
    expect(agentEventPhase({ _tag: 'Progress', percent: 40, text: '   ' }, 'review')).toBeUndefined()
  })

  it('separates running the checks from editing files', () => {
    const verifying = agentEventPhase({ _tag: 'CommandStarted', command: 'pnpm test' }, 'review')
    const editing = agentEventPhase({ _tag: 'FileChanged', changes: [{ path: 'a.ts', kind: 'update' }] }, 'review')

    expect(verifying?._tag).toBe('Verifying')
    expect(editing?._tag).toBe('Editing')
    expect(verifying?.percent).not.toBe(editing?.percent)
  })

  it('says nothing for a finished command, because its start already did', () => {
    expect(agentEventPhase({ _tag: 'CommandCompleted', command: 'pnpm test', output: '', exitCode: 0 }, 'review')).toBeUndefined()
  })

  it('names the work in the phase a plain command puts the turn in', () => {
    expect(agentEventPhase({ _tag: 'CommandStarted', command: 'git diff' }, 'review')?.label).toBe('Reviewing changed files')
    expect(agentEventPhase({ _tag: 'CommandStarted', command: 'git diff' }, 'conflict')?.label).toBe('Resolving merge conflicts')
  })
})

describe('advancedPhase', () => {
  it('names what the agent is doing now after it goes back to editing', () => {
    const verifying = agentPhase('Verifying', 'Running tests and checks')
    const editing = agentPhase('Editing', 'Editing files')

    // The label follows the agent. The rank holds, so the line never regresses.
    expect(advancedPhase(verifying, editing)).toEqual({ _tag: 'Editing', label: 'Editing files', percent: verifying.percent })
  })

  it('stays quiet while the same phase repeats', () => {
    const editing = agentPhase('Editing', 'Editing files')

    expect(advancedPhase(editing, agentPhase('Editing', 'Editing files'))).toBeUndefined()
  })

  it('advances a self-reported phase as its own number rises', () => {
    const first = agentEventPhase({ _tag: 'Progress', percent: 20, text: 'reading the diff' }, 'review')
    const second = agentEventPhase({ _tag: 'Progress', percent: 60, text: 'writing the findings' }, 'review')

    expect(advancedPhase(first!, second!)).toEqual({ _tag: 'Reported', label: 'writing the findings', percent: second!.percent })
  })
})
