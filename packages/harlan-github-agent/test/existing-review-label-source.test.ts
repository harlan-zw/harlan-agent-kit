import type { Octokit } from 'octokit'
import { describe, expect, it } from 'vitest'
import { createGitHubAgentSource } from '../src/github-agent-source.ts'
import { ok } from '../src/result.ts'
import { repositoryMapping } from './fixtures.ts'

const headSha = 'a'.repeat(40)
function harness(heading = '### 🤖 READY · 95/100') {
  const comment = {
    id: 42,
    author_association: 'OWNER',
    user: { login: 'harlan-zw' },
    body: `<!-- harlan-agent-kit:pr-triage -->\n<!-- reviewed-sha: ${headSha} -->\n${heading}`,
    html_url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
  }
  const comments = [comment]
  const pull = { state: 'open', head: { sha: headSha } }
  const client = {
    paginate: () => Promise.resolve(comments),
    rest: {
      issues: { listComments: () => undefined },
      pulls: { get: () => Promise.resolve({ data: pull }) },
    },
  } as unknown as Octokit
  const source = createGitHubAgentSource({
    actorLogin: () => 'harlan-github-agent[bot]',
    createClient: () => client,
    tokens: {
      getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-08-14T00:00:00.000Z' })),
      invalidate: () => undefined,
    },
  })
  return { comment, comments, pull, read: () => source.readExistingReviewLabel(repositoryMapping(), 24, 42, headSha, AbortSignal.timeout(1000)) }
}

describe('reading an existing review label', () => {
  it.each([
    ['### 🤖 READY · 95/100', 'READY'],
    ['### 🤖 BLOCKED', 'BLOCKED'],
    ['### 🤖 REVIEW SKIPPED', 'ADVERSARIAL_REVIEW_SKIPPED'],
    ['**PASS · 95/100 confidence**', 'READY'],
    ['**PENDING**', 'PENDING'],
    ['**BLOCKED**', 'BLOCKED'],
  ])('reads the outcome from %s', async (heading, label) => {
    const test = harness(heading)
    expect(await test.read()).toEqual(ok({ commentId: 42, url: test.comment.html_url, label }))
  })

  it.each(['CONTRIBUTOR', 'NONE'])('rejects a marker from an untrusted %s', async (association) => {
    const test = harness()
    test.comment.author_association = association
    expect(await test.read()).toEqual({
      _tag: 'Err',
      error: { _tag: 'Permanent', message: 'The completed review changed before its label was restored.' },
    })
  })

  it('rejects an unreviewed head', async () => {
    const test = harness()
    test.comment.body = test.comment.body.replace(headSha, 'b'.repeat(40))
    expect((await test.read())._tag).toBe('Err')
  })

  it('yields to a later review on the same head', async () => {
    const test = harness()
    test.comments.push({ ...test.comment, id: 43, html_url: test.comment.html_url.replace('42', '43'), body: test.comment.body.replace('READY', 'REVIEWING') })
    expect((await test.read())._tag).toBe('Err')
  })

  it.each(['closed', 'moved'])('rejects a pull request that %s after the comments were read', async (change) => {
    const test = harness()
    if (change === 'closed')
      test.pull.state = 'closed'
    else
      test.pull.head.sha = 'b'.repeat(40)
    expect(await test.read()).toEqual({
      _tag: 'Err',
      error: { _tag: 'Permanent', message: 'The pull request changed before its review label was restored.' },
    })
  })
})
