import { describe, expect, it } from 'vitest'
import { isReviewRerunCommand } from '../src/review-rerun.ts'

describe('review rerun command', () => {
  it.each([
    '/harlan-agent rerun',
    ' /harlan-agent rerun ',
    '@harlan-github-agent rerun',
    '@harlan-github-agent[bot] rerun',
  ])('accepts %s', (body) => {
    expect(isReviewRerunCommand(body)).toBe(true)
  })

  it.each([
    '/harlan-agent',
    '/harlan-agent rerun this',
    '@harlan-github-agent review',
    'Please /harlan-agent rerun',
  ])('rejects %s', (body) => {
    expect(isReviewRerunCommand(body)).toBe(false)
  })
})
