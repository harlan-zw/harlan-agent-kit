import { describe, expect, it } from 'vitest'
import { batchPlanPrompt, parseBatchPlan } from '../src/batch-worker.ts'

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
