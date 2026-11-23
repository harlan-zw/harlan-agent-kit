import type { FollowUpControls } from '../src/logged-finding-pickup.ts'
import type { ReviewFinding } from '../src/types.ts'
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loggedFindingPickup, normalizeLoggedFindingControls, withLoggedFindingControls, withoutLoggedFindingControls } from '../src/logged-finding-pickup.ts'
import { AUTOMATED_REVIEW_MARKER, automatedDisclosure, followUpSection } from '../src/review-comment.ts'
import { reviewFindingThreadBody } from '../src/review-finding-threads.ts'
import { createWebhookApp } from '../src/webhook.ts'

const fingerprint = 'f'.repeat(64)
const headSha = 'a'.repeat(40)
const repairHere: FollowUpControls = { _tag: 'Open', repairOnHead: true }
const finding = {
  _tag: 'Logged' as const,
  impact: 40,
  summary: 'The parser drops buffered bytes.',
  details: { fingerprint, identity: 'buffered bytes', location: { path: 'src/parser.ts', line: 42 }, proof: 'A split sequence loses bytes.', scope: 'change' as const },
}
const original = `${AUTOMATED_REVIEW_MARKER}\n<!-- reviewed-sha: ${headSha} -->\n- **Logged (40/100):** ${finding.summary}`
const before = withLoggedFindingControls(original, [finding], [], { controls: repairHere })

function payload(after = before.replace('[ ]', '[x]'), from = before) {
  return {
    action: 'edited',
    repository: { full_name: 'harlan-zw/example' },
    issue: { number: 24, pull_request: {} },
    sender: { login: 'harlan-zw' },
    comment: { id: 42, user: { login: 'harlan-github-agent[bot]' }, body: after },
    changes: { body: { from } },
  }
}

function logged(impact: number, summary: string, mark: string, scope?: 'change' | 'existing'): Extract<ReviewFinding, { _tag: 'Logged' }> {
  return {
    _tag: 'Logged',
    impact,
    summary,
    details: { fingerprint: mark.repeat(64), identity: summary, location: { path: 'src/parser.ts', line: impact }, proof: 'It breaks.', ...(scope === undefined ? {} : { scope }) },
  }
}
const added = logged(72, 'Added lines drop bytes.', 'c', 'change')
const existing = logged(55, 'The cache never expires.', 'e', 'existing')
const unplaced = logged(48, 'The retry loops forever.', 'd')
const footer = automatedDisclosure({ kind: 'review', merge: true, commands: ['Rerun'] })
function verdict(findings: readonly ReviewFinding[]): string {
  return [AUTOMATED_REVIEW_MARKER, `<!-- reviewed-sha: ${headSha} -->`, '🟢 **Ready**', '', ...followUpSection('harlan-zw/example', headSha, findings, 'main'), footer].join('\n')
}

describe('logged finding pickup', () => {
  it('accepts a signed inline edit on an individually allowed repository', async () => {
    const inline = reviewFindingThreadBody(finding, { headSha, baseRef: 'main', repairOnHead: true })
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
      _tag: 'Findings',
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
    expect(loggedFindingPickup('issue_comment', payload(after))).toMatchObject({ _tag: 'Findings', fingerprints: [fingerprint] })
  })

  it('rejects edits beyond selecting existing controls', () => {
    expect(loggedFindingPickup('issue_comment', payload(`${before.replace('[ ]', '[x]')}\nForged scope`))).toBeNull()
    expect(loggedFindingPickup('issue_comment', payload(before.replace(fingerprint, 'b'.repeat(64)).replace('[ ]', '[x]')))).toBeNull()
    expect(loggedFindingPickup('issue_comment', payload(before))).toBeNull()
    expect(loggedFindingPickup('issues', payload())).toBeNull()
  })

  it('reads a tick on the issue control as an issue request', () => {
    const issueBody = withLoggedFindingControls(verdict([existing]), [existing], [], { controls: repairHere, baseRef: 'main' })
    expect(loggedFindingPickup('issue_comment', payload(issueBody.replace('- [ ] File this finding', '- [x] File this finding'), issueBody)))
      .toMatchObject({ _tag: 'Findings', fingerprints: [], issueFingerprints: [existing.details.fingerprint] })
  })

  it('keeps distinct controls when two findings share a summary', () => {
    const second = { ...finding, details: { ...finding.details, fingerprint: 'e'.repeat(64) } }
    const body = withLoggedFindingControls(`${original}\n- **Logged (40/100):** ${finding.summary}`, [finding, second], [], { controls: repairHere })
    expect(body).toContain(`logged-finding: ${second.details.fingerprint}`)
  })

  it('keeps task status beside the finding and removes its checkbox', () => {
    const body = withLoggedFindingControls(before, [finding], [{ _tag: 'Repair', fingerprint, status: 'Repair pull request: https://github.com/harlan-zw/example/pull/25', cancellable: false }], { controls: repairHere })
    expect(body).toContain('Repair pull request: https://github.com/harlan-zw/example/pull/25')
    expect(body).not.toContain('[ ]')
    expect(normalizeLoggedFindingControls(before.replace('[ ]', '[x]'))).toBe(before)
    expect(withLoggedFindingControls(before, [finding], [], { controls: repairHere })).toBe(before)
  })

  it.each([
    ['the Status line footer', footer],
    // Frozen: the command line a canonical comment ended with before the Status line.
    ['an old command line', 'Comment `@harlan-agent <change to make>` to request a change, or `@harlan-agent rerun` to review this commit again.'],
  ])('keeps %s last after it binds the controls to the base branch', (_name, last) => {
    const source = `${original}\n\n${last}`
    const decorated = withLoggedFindingControls(source, [finding], [], { controls: repairHere, baseRef: 'main' })

    expect(decorated.split('\n').at(-1)).toBe(last)
    expect(decorated.split('\n').at(-3)).toBe('<!-- finding-base: bWFpbg -->')
    expect(withoutLoggedFindingControls(decorated)).toBe(source)
    expect(withLoggedFindingControls(decorated, [finding], [], { controls: repairHere, baseRef: 'main' })).toBe(decorated)
  })

  it('shows a ticked follow-up as its Repair status, and strips back to the source body', () => {
    const source = verdict([finding])
    const statuses = [{ _tag: 'Repair' as const, fingerprint, status: 'Repair round 1 is fixing this.', cancellable: true }]
    const decorated = withLoggedFindingControls(source, [finding], statuses, { controls: repairHere, baseRef: 'main' })

    expect(decorated).toContain(`  Repair: Repair round 1 is fixing this. <!-- logged-finding: ${fingerprint} -->\n  - [ ] Dismiss this finding <!-- dismiss-logged-finding: ${fingerprint} -->`)
    expect(decorated).not.toContain('Ask an agent to verify and fix this finding')
    expect(decorated).toContain('**In this change.**\n')
    expect(decorated.split('\n').at(-1)).toBe(footer)
    expect(withoutLoggedFindingControls(decorated)).toBe(source)
    expect(withLoggedFindingControls(decorated, [finding], statuses, { controls: repairHere, baseRef: 'main' })).toBe(decorated)
  })

  it('shows a filed follow-up as its issue link', () => {
    const decorated = withLoggedFindingControls(verdict([existing]), [existing], [{ _tag: 'Issue', fingerprint: existing.details.fingerprint, status: 'Filed as #123.' }], { controls: repairHere, baseRef: 'main' })
    expect(decorated).toContain(`- \`55\` The cache never expires.`)
    expect(decorated).toContain(`  Filed as #123. <!-- logged-finding: ${existing.details.fingerprint} -->`)
    expect(decorated).not.toContain('Tick to')
    expect(decorated).not.toContain('- [ ]')
  })

  it('adds the control under a follow-up row and links a row whose thread opened beside the code', () => {
    const second = { ...finding, impact: 62, summary: 'The cache never expires.', details: { ...finding.details, fingerprint: 'e'.repeat(64), identity: 'cache' } }
    const hidden = { ...finding, impact: 12, summary: 'A comment has a typo.', details: { ...finding.details, fingerprint: 'd'.repeat(64), identity: 'typo' } }
    const source = verdict([finding, second, hidden])
    const decorated = withLoggedFindingControls(source, [finding, second, hidden], [], { controls: repairHere, baseRef: 'main', inline: new Map([[second.details.fingerprint, 'https://github.com/harlan-zw/example/pull/24#discussion_r7']]) })

    expect(decorated).toContain('<b>2 follow-ups</b> · none block merge')
    expect(decorated).toContain(`- \`40\` The parser drops buffered bytes. · [\`parser.ts:42\`](https://github.com/harlan-zw/example/blob/${headSha}/src/parser.ts#L42)<br>A split sequence loses bytes.\n  - [ ] Ask an agent to verify and fix this finding <!-- logged-finding: ${fingerprint} -->`)
    expect(decorated).toContain(`The cache never expires. · [\`parser.ts:42\`](https://github.com/harlan-zw/example/blob/${headSha}/src/parser.ts#L42)<br>A split sequence loses bytes.\n  [Open the thread beside the code](https://github.com/harlan-zw/example/pull/24#discussion_r7) <!-- logged-finding: ${'e'.repeat(64)} -->`)
    expect(decorated.match(/Ask an agent to verify and fix this finding/g)).toHaveLength(1)
    expect(decorated).not.toContain(`logged-finding: ${hidden.details.fingerprint}`)
    expect(decorated).toContain('<sub>1 note below 40/100 not shown.</sub>')
    expect(decorated.split('\n').at(-1)).toBe(footer)
  })

  it('prints no tick sentence for a group whose only row links its thread', () => {
    const source = verdict([added, existing])
    const decorated = withLoggedFindingControls(source, [added, existing], [], { controls: repairHere, baseRef: 'main', inline: new Map([[existing.details.fingerprint, 'https://github.com/harlan-zw/example/pull/24#discussion_r9']]) })
    expect(decorated).toContain('**In this change.** Tick to have Repair fix it here, before merge.')
    expect(decorated).toContain('**Already in `main`.**\n')
    expect(decorated).not.toContain('File this finding as an issue')
    expect(withoutLoggedFindingControls(decorated)).toBe(source)
  })

  it('still strips published comments that end with an old selection hint', () => {
    const afterMerge = `${original}\n  - [ ] Ask an agent to verify and fix this finding <!-- logged-finding: ${fingerprint} -->\n\nSelected findings run after merge and open separate pull requests.`
    expect(withoutLoggedFindingControls(afterMerge)).toBe(original)
    const onHead = `${original}\n  - [ ] Ask an agent to verify and fix this finding <!-- logged-finding: ${fingerprint} -->\n  - [ ] Dismiss this finding <!-- dismiss-logged-finding: ${fingerprint} -->\n\n<!-- finding-base: bWFpbg -->\nSelected findings run on this pull request.\n\n${footer}`
    expect(withoutLoggedFindingControls(onHead)).toBe(`${original}\n\n${footer}`)
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

describe('follow-up routing on an open pull request', () => {
  const mix = [added, existing, unplaced]
  const decorate = (repairOnHead: boolean) => withLoggedFindingControls(verdict(mix), mix, [], { controls: { _tag: 'Open', repairOnHead }, baseRef: 'main' })

  it('sends a finding in this change to Repair, and every other finding to an issue', () => {
    const body = decorate(true)
    expect(body).toContain(`**In this change.** Tick to have Repair fix it here, before merge.\n\n- \`72\` Added lines drop bytes.`)
    expect(body).toContain(`  - [ ] Ask an agent to verify and fix this finding <!-- logged-finding: ${added.details.fingerprint} -->\n  - [ ] Dismiss this finding`)
    expect(body).toContain('**Already in `main`.** Tick to file it as an issue.')
    expect(body).toContain(`  - [ ] File this finding as an issue <!-- logged-finding: ${existing.details.fingerprint} -->`)
    expect(body).toContain('**Not matched to the diff.** Tick to file it as an issue.')
    expect(body).toContain(`  - [ ] File this finding as an issue <!-- logged-finding: ${unplaced.details.fingerprint} -->`)
  })

  it('files a finding in this change as an issue when Repair cannot write the head', () => {
    const body = decorate(false)
    expect(body).toContain('**In this change.** Tick to file it as an issue.')
    expect(body).toContain(`  - [ ] File this finding as an issue <!-- logged-finding: ${added.details.fingerprint} -->`)
    expect(body).not.toContain('Ask an agent to verify and fix this finding')
    expect(body).not.toContain('Dismiss this finding')
  })

  it('never offers Repair for a finding without a Finding scope', () => {
    const body = withLoggedFindingControls(verdict([unplaced]), [unplaced], [], { controls: repairHere })
    expect(body).not.toContain('Ask an agent to verify and fix this finding')
    expect(body).toContain('File this finding as an issue')
  })

  it('prints no tick sentence when the repository offers no finding controls', () => {
    const body = withLoggedFindingControls(verdict(mix), mix, [], { baseRef: 'main' })
    expect(body).not.toContain('Tick to')
    expect(body).not.toContain('- [ ]')
    expect(body).toBe(verdict(mix))
  })

  it.each([
    ['every group', mix],
    ['this change only', [added]],
    ['existing code only', [existing]],
    ['an unplaced finding only', [unplaced]],
  ])('strips back to the source body for %s', (_name, findings) => {
    const source = verdict(findings)
    for (const repairOnHead of [true, false]) {
      const decorated = withLoggedFindingControls(source, findings, [], { controls: { _tag: 'Open', repairOnHead }, baseRef: 'main' })
      expect(withoutLoggedFindingControls(decorated)).toBe(source)
      expect(withLoggedFindingControls(decorated, findings, [], { controls: { _tag: 'Open', repairOnHead }, baseRef: 'main' })).toBe(decorated)
    }
  })
})

describe('the Merged control', () => {
  const merged = [AUTOMATED_REVIEW_MARKER, `<!-- reviewed-sha: ${headSha} -->`, '🟣 **Merged** · 2 follow-ups not fixed', '', `- \`72\` Added lines drop bytes.`, `- \`55\` The cache never expires.`, '', automatedDisclosure({ kind: 'review' })].join('\n')
  const controls: FollowUpControls = { _tag: 'Merged', headSha }

  it('offers one control that files every unfixed follow-up, and no control per row', () => {
    const body = withLoggedFindingControls(merged, [added, existing], [], { controls })
    expect(body.split('\n').slice(-3)).toEqual([`- [ ] File these as one issue <!-- logged-findings: ${headSha} -->`, '', automatedDisclosure({ kind: 'review' })])
    expect(body).not.toContain('File this finding as an issue')
    expect(withoutLoggedFindingControls(body)).toBe(merged)
  })

  it('shows the filed issue in place of the control', () => {
    const body = withLoggedFindingControls(merged, [added, existing], [], { controls, mergedIssue: 'Filed as #31.' })
    expect(body).toContain(`Filed as #31. <!-- logged-findings: ${headSha} -->`)
    expect(body).not.toContain('- [ ]')
    expect(withoutLoggedFindingControls(body)).toBe(merged)
  })

  it('offers nothing once every follow-up already has an owner', () => {
    const owned = [
      { _tag: 'Issue' as const, fingerprint: added.details.fingerprint, status: 'Filed as #12.' },
      { _tag: 'Repair' as const, fingerprint: existing.details.fingerprint, status: 'Queued.', cancellable: false },
    ]
    expect(withLoggedFindingControls(merged, [added, existing], owned, { controls })).not.toContain('File these as one issue')
  })

  it('reads its tick as one request for the reviewed head', () => {
    const body = withLoggedFindingControls(merged, [added, existing], [], { controls })
    const ticked = body.replace('- [ ] File these', '- [x] File these')
    expect(loggedFindingPickup('issue_comment', payload(ticked, body))).toMatchObject({ _tag: 'MergedFollowUps', headSha, commentId: 42 })
    expect(loggedFindingPickup('issue_comment', payload(ticked.replace(`logged-findings: ${headSha}`, `logged-findings: ${'b'.repeat(40)}`), body.replace(`logged-findings: ${headSha}`, `logged-findings: ${'b'.repeat(40)}`)))).toBeNull()
  })
})
