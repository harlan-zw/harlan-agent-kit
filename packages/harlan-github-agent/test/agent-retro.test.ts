import type { WorkflowEvent, WorkflowFailureGroup } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { collectAgentRetroEvidence } from '../src/agent-retro.ts'
import { getRoutine } from '../src/routines/index.ts'

const at = '2026-10-11T00:00:00.000Z'
const event: WorkflowEvent = {
  id: 1,
  stream: 'task',
  event: 'failed',
  entityId: 'task-1',
  repository: 'harlan-zw/example',
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

const group: WorkflowFailureGroup = {
  stream: 'task',
  event: 'failed',
  to: 'Failed',
  reason: 'Bearer abcdefghijklmnopqrstuvwxyz',
  count: 2,
  retried: 1,
  newestOccurredAt: at,
  examples: [{ id: 1, entityId: 'task-1', repository: 'harlan-zw/example', itemNumber: 7, occurredAt: at }],
}

describe('agent retro evidence', () => {
  it('keeps failure identity and timing while redacting known token shapes', () => {
    const result = collectAgentRetroEvidence({
      listIncidents: () => [],
      listWorkflowEvents: () => [{ ...event, reason: `Bearer abcdefghijklmnopqrstuvwxyz ${'x'.repeat(1000)}` }],
      summarizeWorkflowEvents: () => [],
      groupWorkflowFailures: () => [group],
    }, new Date(at))
    expect(result.failureSample[0]).toMatchObject({ id: 1, taskId: 'task-1', reason: expect.stringMatching(/^Bearer \*\*\* x+$/), durationMilliseconds: 60000 })
    expect(result.failureSample[0]?.reason).toHaveLength(400)
    expect(result.failureGroups.rows).toEqual([['task', 'failed', 'Failed', 'Bearer ***', 2, 1, [[1, 'task-1', 'harlan-zw/example', 7, at]]]])
    expect(result.coverage).toMatchObject({ events: 'complete', failureEvents: 2, failureGroups: 1, omittedFailureGroups: 0 })
  })

  it('states incomplete coverage when failure groups exceed the limit', () => {
    const groups = Array.from({ length: 151 }, (_, index) => ({ ...group, reason: `cause ${index}` }))
    const result = collectAgentRetroEvidence({
      listIncidents: () => [],
      listWorkflowEvents: () => [],
      summarizeWorkflowEvents: () => [],
      groupWorkflowFailures: () => groups,
    }, new Date(at))
    expect(result.failureGroups.rows).toHaveLength(150)
    expect(result.coverage).toMatchObject({ events: 'incomplete', failureEvents: 302, failureGroups: 151, omittedFailureGroups: 1 })
  })

  it('refuses scans on another repository', () => {
    expect(getRoutine('agent-retro').prepare('harlan-zw/example', { listAgentFeedback: () => [], listImplicitSignals: () => [] })._tag).toBe('Err')
  })

  it('requires a bounded report and verdict even with no proposed fix', () => {
    const routine = getRoutine('agent-retro')
    expect(routine.parseResponse({ report: '', candidates: [] })._tag).toBe('Err')
    expect(routine.parseResponse({ report: 'Read 12 events.', candidates: [] })._tag).toBe('Err')
    expect(routine.parseResponse({ report: 'x'.repeat(20001), verdict: { severity: 'GREEN', coverage: 'complete' }, candidates: [] })._tag).toBe('Err')
    expect(routine.parseResponse({ report: 'No evidence for a repair.', verdict: { severity: 'AMBER', coverage: 'incomplete' }, candidates: [] })).toMatchObject({ _tag: 'Ok', value: { candidates: [] } })
  })

  it('limits proposed work to two changes inside the Agent service or Skills', () => {
    const candidate = { fingerprint: 'one', title: 'Fix one', target: 'packages/harlan-github-agent/src/store.ts', claim: 'Failure.', verification: 'pnpm test', estimatedChangedFiles: 2 }
    const routine = getRoutine('agent-retro')
    expect(routine.selectCandidates([{ ...candidate, target: '../../outside' }, candidate, { ...candidate, fingerprint: 'two' }, { ...candidate, fingerprint: 'three' }])).toHaveLength(2)
    expect(routine.issueWork.verifyChanges(candidate.target, [candidate.target, 'packages/harlan-github-agent/test/store.test.ts'])._tag).toBe('Ok')
    expect(routine.issueWork.verifyChanges(candidate.target, [candidate.target, 'agent-context/AGENTS.md'])._tag).toBe('Err')
  })
})
