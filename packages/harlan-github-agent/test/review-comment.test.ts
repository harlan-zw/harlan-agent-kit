import { describe, expect, it } from 'vitest'
import { progressComment } from '../src/item-agent.ts'
import { findingNextAction, priorAutomatedReviewForHead } from '../src/review-comment.ts'

const headSha = '69c7ef6eaf1ec7bb186f27f46fa343d3d38f1f23'
const baseSha = 'a2bf631b82ed5c386bfa4c384a44720f67182513'

describe('automated review comments', () => {
  it('keeps full advice while removing hidden markers', () => {
    const action = `Keep the complete instructions. ${'Check the next boundary. '.repeat(20)}`.trim()
    expect(findingNextAction(`<!--\n${action}\n-->`)).toBe(action)
  })

  it('drops a stored "As an optional follow-up," prefix', () => {
    expect(findingNextAction('As an optional follow-up, query for span overlap before inserting.')).toBe('query for span overlap before inserting.')
    expect(findingNextAction('Optional follow-up: Optional follow-up. Add a test.')).toBe('Add a test.')
    expect(findingNextAction('As an optional follow-up, pnpm test passes again.')).toBe('pnpm test passes again.')
  })

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

  it('recovers a completed Review from the current Agent comment', () => {
    expect(priorAutomatedReviewForHead([{
      authorAssociation: 'NONE',
      authorLogin: 'harlan-github-agent[bot]',
      body: `<!-- harlan-agent-kit:pr-triage -->\n<!-- reviewed-sha: ${headSha} -->\n<!-- workflow-state: {"_tag":"Review","headSha":"${headSha}","baseSha":"${baseSha}","outcome":"READY","gates":{"merge":"Passed","review":"Passed","ci":"Passed"}} -->\n### 🤖 READY · 100/100`,
      url: 'https://example.com/current-agent-ready',
    }], headSha, 'harlan-github-agent[bot]', baseSha)).toEqual({
      _tag: 'Found',
      authorLogin: 'harlan-github-agent[bot]',
      state: 'complete',
      url: 'https://example.com/current-agent-ready',
    })
  })

  it('keeps PENDING incomplete and reuses a completed Review for the same head', () => {
    const comment = (outcome: 'READY' | 'PENDING', commentBaseSha: string) => ({
      authorAssociation: 'NONE',
      authorLogin: 'harlan-github-agent[bot]',
      body: `<!-- harlan-agent-kit:pr-triage -->\n<!-- reviewed-sha: ${headSha} -->\n<!-- workflow-state: {"_tag":"Review","headSha":"${headSha}","baseSha":"${commentBaseSha}","outcome":"${outcome}","gates":{"merge":"Passed","review":"Passed","ci":"Passed"}} -->\n### 🤖 ${outcome}`,
      url: `https://example.com/current-agent-${outcome.toLowerCase()}`,
    })

    expect(priorAutomatedReviewForHead([comment('PENDING', baseSha)], headSha, 'harlan-github-agent[bot]', baseSha))
      .toEqual({ _tag: 'None' })
    expect(priorAutomatedReviewForHead([comment('READY', 'other-base')], headSha, 'harlan-github-agent[bot]', baseSha))
      .toEqual({
        _tag: 'Found',
        authorLogin: 'harlan-github-agent[bot]',
        state: 'complete',
        url: 'https://example.com/current-agent-ready',
      })
  })
})

describe('running Review comment', () => {
  const priorHeadSha = 'a83128aac51194195b55e94b7a628e3aee018216'

  it('keeps the verdict of the earlier head in view while the new head is reviewed', () => {
    const body = progressComment(headSha, baseSha, { _tag: 'AfterPush', priorHeadSha, priorOutcome: 'READY', findings: 0 }, 'harlan-zw/example')

    expect(body).toBe([
      '<!-- harlan-agent-kit:pr-triage -->',
      `<!-- reviewed-sha: ${headSha} -->`,
      `<!-- workflow-state: {"_tag":"Reviewing","headSha":"${headSha}","baseSha":"${baseSha}"} -->`,
      `⚪ **Reviewing** [\`${headSha.slice(0, 7)}\`](https://github.com/harlan-zw/example/commit/${headSha}) · this comment updates when it finishes`,
      '',
      `<sub>Last review of \`${priorHeadSha.slice(0, 7)}\`: Ready. A new commit replaced it.</sub>`,
      '',
      '<sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan\'s · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>',
    ].join('\n'))
  })

  it('says nothing about an earlier verdict on a first Review', () => {
    const body = progressComment(headSha, baseSha, { _tag: 'FirstReview' })

    expect(body).not.toContain('Last review')
  })

  it('reads as a running Review, never as the earlier verdict it quotes', () => {
    const body = progressComment(headSha, baseSha, { _tag: 'AfterPush', priorHeadSha, priorOutcome: 'Ready', findings: 0 })

    expect(priorAutomatedReviewForHead([{
      authorAssociation: 'OWNER',
      authorLogin: 'harlan-zw',
      body,
      url: 'https://example.com/running',
    }], headSha, 'harlan-github-agent[bot]')).toEqual({
      _tag: 'Found',
      authorLogin: 'harlan-zw',
      state: 'active',
      url: 'https://example.com/running',
    })
    expect(priorAutomatedReviewForHead([{
      authorAssociation: 'NONE',
      authorLogin: 'harlan-github-agent[bot]',
      body,
      url: 'https://example.com/running',
    }], headSha, 'harlan-github-agent[bot]')).toEqual({ _tag: 'None' })
  })
})
