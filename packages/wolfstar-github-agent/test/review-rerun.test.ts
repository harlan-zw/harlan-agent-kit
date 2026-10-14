import { describe, expect, it } from 'vitest'
import { isReviewRerunCommand, parsePullRequestCommand } from '../src/review-rerun.ts'

describe('pull request commands', () => {
  it('preserves the requested change from an Agent mention', () => {
    expect(parsePullRequestCommand('@wolfstar-github-agent can we just changing trailingSlash to false ')).toEqual({
      _tag: 'Change',
      instruction: 'can we just changing trailingSlash to false',
    })
  })

  it.each(['@wolfstar-agent', 'Please @wolfstar-agent fix it', '> @wolfstar-agent fix it', '@wolfstar-agents fix it'])(
    'ignores %s',
    (body) => {
      expect(parsePullRequestCommand(body)).toBeNull()
    },
  )

  it.each(['@wolfstar-agent', '@wolfstar-github-agent', '@wolfstar-github-agent[bot]', '/wolfstar-agent'])(
    'accepts %s requests',
    (handle) => {
      expect(parsePullRequestCommand(`${handle} change it\nKeep the tests.`)).toEqual({
        _tag: 'Change',
        instruction: 'change it\nKeep the tests.',
      })
      expect(parsePullRequestCommand(`${handle} rerun`)).toEqual({ _tag: 'Rerun' })
    },
  )
})

describe('review rerun command', () => {
  it.each([
    '/wolfstar-agent rerun',
    ' /wolfstar-agent rerun ',
    '@wolfstar-agent rerun',
    '@wolfstar-github-agent rerun',
    '@wolfstar-github-agent[bot] rerun',
  ])('accepts %s', (body) => {
    expect(isReviewRerunCommand(body)).toBe(true)
  })

  it.each([
    '/wolfstar-agent',
    '/wolfstar-agent rerun this',
    '@wolfstar-agent',
    '@wolfstar-agent review',
    '@wolfstar-agents rerun',
    '@wolfstar-github-agent review',
    'Please /wolfstar-agent rerun',
  ])('rejects %s', (body) => {
    expect(isReviewRerunCommand(body)).toBe(false)
  })
})
