import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loggedFindingPickup, normalizeLoggedFindingControls, withLoggedFindingControls } from '../src/logged-finding-pickup.ts'
import { AUTOMATED_REVIEW_MARKER } from '../src/review-comment.ts'
import { createWebhookApp } from '../src/webhook.ts'

const fingerprint = 'f'.repeat(64)
const headSha = 'a'.repeat(40)
const finding = {
  _tag: 'Logged' as const,
  impact: 40,
  summary: 'The parser drops buffered bytes.',
  details: { fingerprint, identity: 'buffered bytes', location: { path: 'src/parser.ts', line: 42 }, proof: 'A split sequence loses bytes.' },
}
const original = `${AUTOMATED_REVIEW_MARKER}\n<!-- reviewed-sha: ${headSha} -->\n- **Logged (40/100):** ${finding.summary}`
const before = withLoggedFindingControls(original, [finding], [])

function payload(after = before.replace('[ ]', '[x]')) {
  return {
    action: 'edited',
    repository: { full_name: 'harlan-zw/example' },
    issue: { number: 24, pull_request: {} },
    sender: { login: 'harlan-zw' },
    comment: { id: 42, user: { login: 'harlan-github-agent[bot]' }, body: after },
    changes: { body: { from: before } },
  }
}

describe('logged finding pickup', () => {
  it('binds a checkbox click to the finding, comment, and reviewed commit', () => {
    expect(loggedFindingPickup('issue_comment', payload())).toEqual({
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      headSha,
      commentId: 42,
      requestedBy: 'harlan-zw',
      commentAuthor: 'harlan-github-agent[bot]',
      fingerprints: [fingerprint],
      before,
    })
  })

  it('rejects edits beyond selecting existing controls', () => {
    expect(loggedFindingPickup('issue_comment', payload(`${before.replace('[ ]', '[x]')}\nForged scope`))).toBeNull()
    expect(loggedFindingPickup('issue_comment', payload(before.replace(fingerprint, 'b'.repeat(64)).replace('[ ]', '[x]')))).toBeNull()
    expect(loggedFindingPickup('issue_comment', payload(before))).toBeNull()
    expect(loggedFindingPickup('issues', payload())).toBeNull()
  })

  it('keeps distinct controls when two findings share a summary', () => {
    const second = { ...finding, details: { ...finding.details, fingerprint: 'e'.repeat(64) } }
    const body = withLoggedFindingControls(`${original}\n- **Logged (40/100):** ${finding.summary}`, [finding, second], [])
    expect(body).toContain(`logged-finding: ${second.details.fingerprint}`)
  })

  it('keeps task status beside the finding and removes its checkbox', () => {
    const body = withLoggedFindingControls(before, [finding], [{ fingerprint, status: 'Repair pull request: https://github.com/harlan-zw/example/pull/25' }])
    expect(body).toContain('Repair pull request: https://github.com/harlan-zw/example/pull/25')
    expect(body).not.toContain('[ ]')
    expect(normalizeLoggedFindingControls(before.replace('[ ]', '[x]'))).toBe(before)
    expect(withLoggedFindingControls(before, [finding], [])).toBe(before)
  })
  it.each(['valid', 'sender', 'actor', 'signature', 'disabled'])('accepts only an authorized signed click: %s', async (kind) => {
    const requests: unknown[] = []
    const secret = 'secret'
    const app = createWebhookApp({
      secret,
      allowedOwners: ['harlan-zw'],
      logger: { info: () => undefined },
      onHint: () => undefined,
      loggedFindingPickup: { allowedAuthor: 'harlan-zw', actorLogin: () => kind === 'disabled' ? null : 'harlan-github-agent[bot]', apply: request => requests.push(request) },
    })
    const input = payload()
    if (kind === 'sender')
      input.sender.login = 'someone-else'
    if (kind === 'actor')
      input.comment.user.login = 'someone-else'
    const body = JSON.stringify(input)
    const signature = createHmac('sha256', kind === 'signature' ? 'wrong' : secret).update(body).digest('hex')
    const deliver = () => app.fetch(new Request('http://localhost/webhook', { method: 'POST', body, headers: { 'x-github-event': 'issue_comment', 'x-github-delivery': 'delivery', 'x-hub-signature-256': `sha256=${signature}` } }))
    await deliver()
    await deliver()
    expect(requests).toEqual(kind === 'valid' ? [expect.objectContaining({ fingerprints: [fingerprint], requestId: 'delivery' })] : [])
  })
})
