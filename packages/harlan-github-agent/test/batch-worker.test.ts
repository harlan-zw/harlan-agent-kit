import type { BatchUnit } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { batchPlanPrompt, createBatchWorker, parseBatchPlan } from '../src/batch-worker.ts'
import { ok } from '../src/result.ts'
import { repositoryMapping } from './fixtures.ts'

describe('parseBatchPlan', () => {
  it('reads units with their stack order and cleans the prose', () => {
    expect(parseBatchPlan(JSON.stringify({
      summary: 'Two units.\nOne stacks.',
      units: [
        { issueNumbers: [101, 102], dependsOn: null, rationale: 'Same helper.' },
        { issueNumbers: [103], dependsOn: 0, rationale: 'Needs the helper.' },
      ],
    }))).toEqual({ _tag: 'Ok', value: {
      summary: 'Two units. One stacks.',
      units: [
        { issueNumbers: [101, 102], dependsOn: null, rationale: 'Same helper.' },
        { issueNumbers: [103], dependsOn: 0, rationale: 'Needs the helper.' },
      ],
    } })
  })

  it('names the broken field', () => {
    expect(parseBatchPlan('not json')).toEqual({ _tag: 'Err', error: 'The agent returned malformed Batch plan JSON.' })
    expect(parseBatchPlan(JSON.stringify({ summary: 'x', units: [{ issueNumbers: ['101'], dependsOn: null, rationale: '' }] })))
      .toEqual({ _tag: 'Err', error: 'The agent returned a Batch plan unit without valid issue numbers.' })
    expect(parseBatchPlan(JSON.stringify({ summary: 'x', units: [{ issueNumbers: [101], dependsOn: -1, rationale: '' }] })))
      .toEqual({ _tag: 'Err', error: 'The agent returned a Batch plan unit with an invalid dependsOn.' })
  })
})

describe('batchPlanPrompt', () => {
  it('hands the turn every issue with its target and fix-with hints, and forbids edits', () => {
    const prompt = batchPlanPrompt({
      repository: 'harlan-zw/example',
      issues: [
        { taskId: 't1', issueNumber: 101, title: 'A', body: 'Body A', triageSummary: 'Summary A', relatedIssues: [102], target: 'src/a.ts' },
        { taskId: 't2', issueNumber: 102, title: 'B', body: 'Body B', triageSummary: null, relatedIssues: [], target: null },
      ],
    })
    expect(prompt).toContain('"number":101')
    expect(prompt).toContain('"fixWith":[102]')
    expect(prompt).toContain('"target":"src/a.ts"')
    expect(prompt).toContain('Do not edit files, commit, push, or post comments.')
    expect(prompt).toContain('Every issue appears in exactly one unit.')
  })
})

describe('batch worker unit failures', () => {
  it('keeps running when the store refuses the failure it is recording', async () => {
    // The store closed under the Batch. Recording the unit failure fails the
    // same way the unit did, and that must not take the service down with it.
    const errors: unknown[] = []
    const repository = repositoryMapping()
    const unit: BatchUnit = {
      id: 'unit-1',
      position: 0,
      primaryTaskId: 'task-1',
      issueNumbers: [12],
      dependsOnUnitId: null,
      rationale: 'Alone.',
      state: { _tag: 'Waiting' },
    }
    const worker = createBatchWorker({
      canClaimIssueWork: () => true,
      github: { getIssueTriageSnapshot: () => Promise.reject(new Error('The Batch reads no snapshot here.')) },
      issueWork: { run: () => Promise.reject(new Error('No unit Task is ever claimed.')) },
      leaseMilliseconds: 60_000,
      logger: { info: () => undefined, error: error => errors.push(error) },
      now: () => new Date('2026-09-04T06:03:11.000Z'),
      runtime: {} as never,
      store: {
        claimBatchUnitTask: () => null,
        completeCombinedIssueWork: () => undefined,
        getBatchDependency: () => ({ _tag: 'Unavailable', reason: 'The unit failed.' }),
        recordBatchPlan: () => [],
        settleBatchUnit: () => {
          throw new Error('database is not open')
        },
      } as never,
      validateMapping: () => Promise.resolve(ok(repository)),
      workerId: 'worker-1',
      workspaces: { prepareBatch: () => Promise.reject(new Error('The Batch prepares no workspace here.')) },
    })

    const result = await worker.run({
      id: 'batch-1',
      repository: repository.github,
      repositoryMapping: repository,
      issues: [{ taskId: 'task-1', issueNumber: 12, title: 'Broken', body: '', triageSummary: null, relatedIssues: [], target: null }],
      units: [unit],
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-09-04T10:03:11.000Z' },
      createdAt: '2026-09-04T05:14:15.000Z',
      updatedAt: '2026-09-04T05:14:15.000Z',
    } as never, new AbortController().signal)

    expect(result._tag).toBe('Ok')
    expect(errors.map(error => error instanceof Error ? error.message : String(error))).toContain('database is not open')
  })
})
