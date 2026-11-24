import { describe, expect, it } from 'vitest'
import { parseReviewResponse } from '../src/item-agent.ts'

function finding(overrides: Record<string, unknown> = {}) {
  return {
    identity: 'stale-comment',
    path: 'src/parser.ts',
    line: 12,
    proof: 'The comment names a function the diff removed.',
    impact: 81,
    regressionTest: 'Split one sequence across two chunks and assert the original string.',
    summary: 'The comment is stale.',
    nextAction: 'Rename the function in the comment.',
    ...overrides,
  }
}

function review(verdict: 'sound' | 'wrong', findings: unknown[]) {
  return JSON.stringify({ checked: 'the changed files', notChecked: null, premise: { verdict, reason: 'The change keeps its intent.' }, findings, confidence: 80 })
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
    [[finding({ impact: 101 })], 'findings[0].impact'],
    [[finding({ impact: -1 })], 'findings[0].impact'],
  ])('names the field a rejected result breaks', async (findings, field) => {
    const result = await parseReviewResponse(review('sound', findings))

    expect(result._tag === 'Err' && result.error).toContain(field)
  })

  it.each([
    'As an optional follow-up, query for span overlap before inserting.',
    'Optional follow-up: query for span overlap before inserting.',
    'Optional follow-up. As an optional follow-up, query for span overlap before inserting.',
  ])('drops the optional follow-up prefix where the answer enters: %s', async (nextAction) => {
    const result = await parseReviewResponse(review('sound', [finding({ impact: 40, nextAction })]))

    expect(result._tag === 'Ok' && result.value.findings[0]?.nextAction).toBe('query for span overlap before inserting.')
  })

  it('keeps the casing of a command after the prefix', async () => {
    const result = await parseReviewResponse(review('sound', [finding({ impact: 40, nextAction: 'As an optional follow-up, pnpm lint --fix the parser.' })]))

    expect(result._tag === 'Ok' && result.value.findings[0]?.nextAction).toBe('pnpm lint --fix the parser.')
  })

  it('names nextAction when the prefix was the whole answer', async () => {
    const result = await parseReviewResponse(review('sound', [finding({ impact: 40, nextAction: 'As an optional follow-up,' })]))

    expect(result._tag === 'Err' && result.error).toContain('findings[0].nextAction')
  })

  it('names the rule a wrong premise with no findings breaks', async () => {
    const result = await parseReviewResponse(review('wrong', []))

    expect(result._tag === 'Err' && result.error).toContain('wrong premise needs at least one finding')
  })
})

describe('what the Review checked', () => {
  const answer = (coverage: Record<string, unknown>) => JSON.stringify({ premise: { verdict: 'sound', reason: 'The change keeps its intent.' }, findings: [], confidence: 90, ...coverage })

  it.each(['complete', 'incomplete'])('preserves the caller verification answer: %s', async (callerVerification) => {
    const result = await parseReviewResponse(answer({ checked: 'affected callers', notChecked: null, callerVerification }))

    expect(result._tag === 'Ok' && result.value.callerVerification).toBe(callerVerification)
  })

  it.each([null, true, 'unknown', {}])('rejects an invalid caller verification answer: %j', async (callerVerification) => {
    const result = await parseReviewResponse(answer({ checked: 'affected callers', notChecked: null, callerVerification }))

    expect(result._tag === 'Err' && result.error).toContain('callerVerification must be complete or incomplete')
  })

  it('keeps what the Review exercised and its largest gap, on one line each', async () => {
    const result = await parseReviewResponse(answer({ checked: 'Timeline reads against\ndense windows', notChecked: 'the dashboard in a browser' }))

    expect(result).toMatchObject({ _tag: 'Ok', value: { checked: 'Timeline reads against dense windows', notChecked: 'the dashboard in a browser' } })
  })

  it('accepts a Review that skipped nothing', async () => {
    const result = await parseReviewResponse(answer({ checked: 'every changed file', notChecked: null }))

    expect(result).toMatchObject({ _tag: 'Ok', value: { notChecked: null } })
  })

  it.each([
    [{ notChecked: null }, 'checked must be a non-empty string'],
    [{ checked: ' ', notChecked: null }, 'checked must be a non-empty string'],
    [{ checked: 'every changed file' }, 'notChecked must be null or a non-empty string'],
    [{ checked: 'every changed file', notChecked: '' }, 'notChecked must be null or a non-empty string'],
  ])('names the coverage field a rejected answer breaks: %o', async (coverage, message) => {
    const result = await parseReviewResponse(answer(coverage))

    expect(result._tag === 'Err' && result.error).toContain(message)
  })
})
