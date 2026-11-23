import { describe, expect, it } from 'vitest'
import { isReviewRerunCommand, parsePullRequestCommand } from '../src/review-rerun.ts'

describe('pull request commands', () => {
  it('preserves the requested change from an Agent mention', () => {
    expect(parsePullRequestCommand('@harlan-github-agent can we just changing trailingSlash to false '))
      .toEqual({ _tag: 'Change', instruction: 'can we just changing trailingSlash to false' })
  })

  it.each(['@harlan-agent', 'Please @harlan-agent fix it', '> @harlan-agent fix it', '@harlan-agents fix it'])('ignores %s', (body) => {
    expect(parsePullRequestCommand(body)).toBeNull()
  })

  it.each(['@harlan-agent', '@harlan-github-agent', '@harlan-github-agent[bot]', '/harlan-agent'])('accepts %s requests', (handle) => {
    expect(parsePullRequestCommand(`${handle} change it\nKeep the tests.`))
      .toEqual({ _tag: 'Change', instruction: 'change it\nKeep the tests.' })
    expect(parsePullRequestCommand(`${handle} rerun`)).toEqual({ _tag: 'Rerun' })
    expect(parsePullRequestCommand(`${handle} stop`)).toEqual({ _tag: 'Stop' })
  })

  it.each([' @harlan-agent stop ', '@harlan-agent STOP', '/harlan-agent\tStop'])('reads %j as a stop', (body) => {
    expect(parsePullRequestCommand(body)).toEqual({ _tag: 'Stop' })
  })

  it('ignores a stop in the middle of a sentence', () => {
    expect(parsePullRequestCommand('Please @harlan-agent stop')).toBeNull()
  })

  it('keeps a longer instruction as a change request', () => {
    expect(parsePullRequestCommand('@harlan-agent stop using the cache'))
      .toEqual({ _tag: 'Change', instruction: 'stop using the cache' })
  })
})

describe('review rerun command', () => {
  it.each([
    '/harlan-agent rerun',
    ' /harlan-agent rerun ',
    '@harlan-agent rerun',
    '@harlan-github-agent rerun',
    '@harlan-github-agent[bot] rerun',
  ])('accepts %s', (body) => {
    expect(isReviewRerunCommand(body)).toBe(true)
  })

  it.each([
    '/harlan-agent',
    '/harlan-agent rerun this',
    '@harlan-agent',
    '@harlan-agent review',
    '@harlan-agents rerun',
    '@harlan-github-agent review',
    'Please /harlan-agent rerun',
  ])('rejects %s', (body) => {
    expect(isReviewRerunCommand(body)).toBe(false)
  })
})
