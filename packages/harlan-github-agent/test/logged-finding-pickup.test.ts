import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loggedFindingPickup, normalizeLoggedFindingControls, withLoggedFindingControls, withoutLoggedFindingControls } from '../src/logged-finding-pickup.ts'
import { AUTOMATED_REVIEW_MARKER, automatedDisclosure, followUpSection } from '../src/review-comment.ts'
import { reviewFindingThreadBody } from '../src/review-finding-threads.ts'
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
  it('accepts a signed inline edit on an individually allowed repository', async () => {
    const inline = reviewFindingThreadBody(finding, headSha, 'main')
    const data = payload(inline.replace('[ ]', '[x]'))
    const body = JSON.stringify({
      ...data,
      issue: undefined,
      repository: { full_name: 'unjs/unhead' },
      pull_request: { number: 24 },
      changes: { body: { from: inline } },
      comment: { ...data.comment, id: 4_640_421_240 },
    })
    const requests: unknown[] = []
    const app = createWebhookApp({
      secret: 'inline-test',
      allowedOwners: ['harlan-zw', 'unjs/unhead'],
      logger: { info: () => undefined },
      onHint: () => undefined,
      loggedFindingPickup: {
        allowedAuthor: 'harlan-zw',
        actorLogin: () => 'harlan-github-agent[bot]',
        apply: (request) => { requests.push(request) },
      },
    })
    const response = await app.fetch(new Request('http://localhost/webhook', {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request_review_comment',
        'x-github-delivery': 'inline-edit',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'inline-test').update(body).digest('hex')}`,
      },
      body,
    }))
    expect(response.status).toBe(204)
    expect(requests).toEqual([expect.objectContaining({ repository: 'unjs/unhead', inline: true, headSha, commentId: 4_640_421_240, fingerprints: [fingerprint] })])
  })

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

  it('accepts a checkbox click when GitHub converts line endings to CRLF', () => {
    const after = before.replace('[ ]', '[x]').replaceAll('\n', '\r\n')
    expect(loggedFindingPickup('issue_comment', payload(after))?.fingerprints).toEqual([fingerprint])
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

  it.each([
    ['the Status line footer', automatedDisclosure({ kind: 'review', merge: true, commands: ['Change', 'Rerun'] })],
    // Frozen: the command line a canonical comment ended with before the Status line.
    ['an old command line', 'Comment `@harlan-agent <change to make>` to request a change, or `@harlan-agent rerun` to review this commit again.'],
  ])('keeps %s last after it adds the selection hint', (_name, footer) => {
    const source = `${original}\n\n${footer}`
    const decorated = withLoggedFindingControls(source, [finding], [])

    expect(decorated.split('\n').at(-1)).toBe(footer)
    expect(decorated).toContain('Selected findings run after merge and open separate pull requests.')
    expect(withoutLoggedFindingControls(decorated)).toBe(source)
    expect(withLoggedFindingControls(decorated, [finding], [])).toBe(decorated)
  })

  it('shows a ticked follow-up as its Repair status, and strips back to the source body', () => {
    const footer = automatedDisclosure({ kind: 'review', merge: true, commands: ['Rerun'] })
    const source = [AUTOMATED_REVIEW_MARKER, `<!-- reviewed-sha: ${headSha} -->`, '🟢 **Ready**', '', ...followUpSection('harlan-zw/example', headSha, [finding]), footer].join('\n')
    const decorated = withLoggedFindingControls(source, [finding], [{ fingerprint, status: 'Repair round 1 is fixing this.', cancellable: true }], { target: 'head', baseRef: 'main' })

    expect(decorated).toContain(`  Repair: Repair round 1 is fixing this. <!-- logged-finding: ${fingerprint} -->\n  - [ ] Dismiss this finding <!-- dismiss-logged-finding: ${fingerprint} -->`)
    expect(decorated).not.toContain('Ask an agent to verify and fix this finding')
    expect(decorated.split('\n').at(-1)).toBe(footer)
    expect(withoutLoggedFindingControls(decorated)).toBe(source)
    expect(withLoggedFindingControls(decorated, [finding], [{ fingerprint, status: 'Repair round 1 is fixing this.', cancellable: true }], { target: 'head', baseRef: 'main' })).toBe(decorated)
  })

  it('adds the control under a follow-up row and recounts the fold when a row moves inline', () => {
    const second = { ...finding, impact: 62, summary: 'The cache never expires.', details: { ...finding.details, fingerprint: 'e'.repeat(64), identity: 'cache' } }
    const hidden = { ...finding, impact: 12, summary: 'A comment has a typo.', details: { ...finding.details, fingerprint: 'd'.repeat(64), identity: 'typo' } }
    const footer = automatedDisclosure({ kind: 'review', merge: true })
    const source = [AUTOMATED_REVIEW_MARKER, `<!-- reviewed-sha: ${headSha} -->`, '🟢 **Ready**', '', ...followUpSection('harlan-zw/example', headSha, [finding, second, hidden]), footer].join('\n')
    const decorated = withLoggedFindingControls(source, [finding, second, hidden], [], { target: 'head', baseRef: 'main', inline: new Set([second.details.fingerprint]) })

    expect(decorated).toContain('<b>1 follow-up</b> · none block merge')
    expect(decorated).toContain(`- \`40\` The parser drops buffered bytes. · [\`parser.ts:42\`](https://github.com/harlan-zw/example/blob/${headSha}/src/parser.ts#L42)\n  - [ ] Ask an agent to verify and fix this finding <!-- logged-finding: ${fingerprint} -->`)
    expect(decorated).not.toContain('The cache never expires.')
    expect(decorated).not.toContain(`logged-finding: ${hidden.details.fingerprint}`)
    expect(decorated).toContain('<sub>1 note below 40/100 not shown.</sub>')
    expect(decorated.split('\n').at(-1)).toBe(footer)
    expect(decorated.split('\n').at(-3)).toBe('Selected findings run on this pull request.')
  })

  it('still strips a published comment that ends with the selection hint', () => {
    expect(before.endsWith('Selected findings run after merge and open separate pull requests.')).toBe(true)
    expect(withoutLoggedFindingControls(before)).toBe(original)
  })
  it.each(['valid', 'sender', 'actor', 'signature', 'disabled'])('accepts only an authorized signed click: %s', async (kind) => {
    const requests: unknown[] = []
    const secret = 'secret'
    const app = createWebhookApp({
      secret,
      allowedOwners: ['harlan-zw'],
      logger: { info: () => undefined },
      onHint: () => undefined,
      loggedFindingPickup: { allowedAuthor: 'harlan-zw', actorLogin: () => kind === 'disabled' ? null : 'harlan-github-agent[bot]', apply: (request) => { requests.push(request) } },
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
