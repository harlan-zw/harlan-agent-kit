import { describe, expect, it } from 'vitest'
import { priorAutomatedReviewForHead } from '../src/review-comment.ts'

const headSha = '69c7ef6eaf1ec7bb186f27f46fa343d3d38f1f23'

describe('automated review comments', () => {
  it('recognizes the current format from a trusted maintainer', () => {
    expect(priorAutomatedReviewForHead([{
      authorAssociation: 'OWNER',
      authorLogin: 'harlan-zw',
      body: `<!-- harlan-agent-kit:pr-triage -->\n<!-- reviewed-sha: ${headSha} -->\n### 🤖 READY · 100/100`,
      url: 'https://github.com/harlan-zw/request-indexing/pull/35#issuecomment-1',
    }], headSha, 'harlan-github-agent[bot]')).toEqual({
      _tag: 'Found',
      authorLogin: 'harlan-zw',
      state: 'complete',
      url: 'https://github.com/harlan-zw/request-indexing/pull/35#issuecomment-1',
    })
  })

  it('recognizes the legacy review on request-indexing pull request 35', () => {
    expect(priorAutomatedReviewForHead([{
      authorAssociation: 'OWNER',
      authorLogin: 'harlan-zw',
      body: `<!-- harlan-agent-kit:pr-triage -->\n**PASS · 100/100 confidence**\n- Reviewed \`${headSha}\` against \`main@base\``,
      url: 'https://github.com/harlan-zw/request-indexing/pull/35#issuecomment-5282079076',
    }], headSha, 'harlan-github-agent[bot]')).toEqual({
      _tag: 'Found',
      authorLogin: 'harlan-zw',
      state: 'complete',
      url: 'https://github.com/harlan-zw/request-indexing/pull/35#issuecomment-5282079076',
    })
  })

  it('ignores stale, untrusted, and current agent comments', () => {
    expect(priorAutomatedReviewForHead([
      {
        authorAssociation: 'OWNER',
        authorLogin: 'harlan-zw',
        body: '<!-- harlan-agent-kit:pr-triage -->\n<!-- reviewed-sha: old-head -->\n### 🤖 READY · 100/100',
        url: 'https://example.com/stale',
      },
      {
        authorAssociation: 'CONTRIBUTOR',
        authorLogin: 'outside-user',
        body: `<!-- harlan-agent-kit:pr-triage -->\n<!-- reviewed-sha: ${headSha} -->\n### 🤖 READY · 100/100`,
        url: 'https://example.com/untrusted',
      },
      {
        authorAssociation: 'NONE',
        authorLogin: 'harlan-github-agent[bot]',
        body: `<!-- harlan-agent-kit:pr-triage -->\n<!-- reviewed-sha: ${headSha} -->\n### 🤖 REVIEWING · Review`,
        url: 'https://example.com/current-agent',
      },
    ], headSha, 'harlan-github-agent[bot]')).toEqual({ _tag: 'None' })
  })
})
