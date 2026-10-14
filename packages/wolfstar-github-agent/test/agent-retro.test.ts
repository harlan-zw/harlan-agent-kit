import type { WorkflowEvent } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { collectAgentRetroEvidence } from '../src/agent-retro.ts'
import { getRoutine } from '../src/routines/index.ts'

const at = '2026-10-11T00:00:00.000Z'
const event: WorkflowEvent = {
  id: 1,
  stream: 'task',
  event: 'failed',
  entityId: 'task-1',
  repository: 'wolfstar-project/example',
  itemNumber: 7,
  revisionId: null,
  taskId: 'task-1',
  from: 'Running',
  to: 'Failed',
  reason: 'Bearer abcdefghijklmnopqrstuvwxyz',
  attempt: 3,
  fence: 1,
  durationMilliseconds: 60000,
  usage: null,
  occurredAt: at,
}

describe('agent retro evidence', () => {
  it('keeps failure identity and timing while redacting known token shapes', () => {
    const result = collectAgentRetroEvidence(
      { listIncidents: () => [], listWorkflowEvents: () => [event] },
      new Date(at),
    )
    expect(result.events[0]).toMatchObject({
      id: 1,
      taskId: 'task-1',
      reason: 'Bearer ***',
      durationMilliseconds: 60000,
    })
    expect(result.coverage.events).toBe('complete')
  })

  it('excludes old events and states when the window exceeds the source limit', () => {
    const result = collectAgentRetroEvidence(
      {
        listIncidents: () => [],
        listWorkflowEvents: () => Array.from({ length: 1000 }, (_, id) => ({ ...event, id })),
      },
      new Date(at),
    )
    expect(result.coverage.events).toBe('incomplete')
    expect(result.events).toHaveLength(200)
    expect(result.coverage.omittedEvents).toBe(800)
    const old = collectAgentRetroEvidence(
      { listIncidents: () => [], listWorkflowEvents: () => [{ ...event, occurredAt: '2026-09-01T00:00:00Z' }] },
      new Date(at),
    )
    expect(old.events).toEqual([])
  })

  it('refuses scans on another repository', () => {
    expect(getRoutine('agent-retro').prepare('wolfstar-project/example', { listAgentFeedback: () => [] })._tag).toBe(
      'Err',
    )
  })

  it('requires a bounded report and verdict even with no proposed fix', () => {
    const routine = getRoutine('agent-retro')
    expect(routine.parseResponse({ report: '', candidates: [] })._tag).toBe('Err')
    expect(routine.parseResponse({ report: 'Read 12 events.', candidates: [] })._tag).toBe('Err')
    expect(
      routine.parseResponse({
        report: 'x'.repeat(20001),
        verdict: { severity: 'GREEN', coverage: 'complete' },
        candidates: [],
      })._tag,
    ).toBe('Err')
    expect(
      routine.parseResponse({
        report: 'No evidence for a repair.',
        verdict: { severity: 'AMBER', coverage: 'incomplete' },
        candidates: [],
      }),
    ).toMatchObject({ _tag: 'Ok', value: { candidates: [] } })
  })

  it('limits proposed work to two changes inside the Agent service or Skills', () => {
    const candidate = {
      fingerprint: 'one',
      title: 'Fix one',
      target: 'packages/wolfstar-github-agent/src/store.ts',
      claim: 'Failure.',
      verification: 'pnpm test',
      estimatedChangedFiles: 2,
    }
    const routine = getRoutine('agent-retro')
    expect(
      routine.selectCandidates([
        { ...candidate, target: '../../outside' },
        candidate,
        { ...candidate, fingerprint: 'two' },
        { ...candidate, fingerprint: 'three' },
      ]),
    ).toHaveLength(2)
    expect(
      routine.issueWork.verifyChanges(candidate.target, [
        candidate.target,
        'packages/wolfstar-github-agent/test/store.test.ts',
      ])._tag,
    ).toBe('Ok')
    expect(routine.issueWork.verifyChanges(candidate.target, [candidate.target, 'agent-context/AGENTS.md'])._tag).toBe(
      'Err',
    )
  })
})
