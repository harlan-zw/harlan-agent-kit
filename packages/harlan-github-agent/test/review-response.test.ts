import { describe, expect, it } from 'vitest'
import { parseReviewResponse } from '../src/item-agent.ts'

function finding(overrides: Record<string, unknown> = {}) {
  return {
    identity: 'stale-comment',
    path: 'src/parser.ts',
    line: 12,
    proof: 'The comment names a function the diff removed.',
    regressionTest: 'Split one sequence across two chunks and assert the original string.',
    summary: 'The comment is stale.',
    nextAction: 'Rename the function in the comment.',
    ...overrides,
  }
}

function review(verdict: 'sound' | 'wrong', findings: unknown[]) {
  return JSON.stringify({ premise: { verdict, reason: 'The change keeps its intent.' }, findings, confidence: 80 })
}

describe('parseReviewResponse', () => {
  it('accepts a sound finding no test can cover, as the schema allows', async () => {
    const result = await parseReviewResponse(review('sound', [finding({ regressionTest: null })]))

    expect(result._tag).toBe('Ok')
    expect(result._tag === 'Ok' && result.value.findings[0]?.regressionTest).toBeNull()
  })

  it('records no regression test for a wrong premise, whatever the agent named', async () => {
    const result = await parseReviewResponse(review('wrong', [finding()]))

    expect(result._tag === 'Ok' && result.value.findings[0]?.regressionTest).toBeNull()
  })

  it.each([
    [[finding({ summary: ' ' })], 'findings[0].summary'],
    [[finding(), finding({ line: 0 })], 'findings[1].line'],
    [[finding({ regressionTest: '' })], 'findings[0].regressionTest'],
  ])('names the field a rejected result breaks', async (findings, field) => {
    const result = await parseReviewResponse(review('sound', findings))

    expect(result._tag === 'Err' && result.error).toContain(field)
  })

  it('names the rule a wrong premise with no findings breaks', async () => {
    const result = await parseReviewResponse(review('wrong', []))

    expect(result._tag === 'Err' && result.error).toContain('wrong premise needs at least one finding')
  })
})
