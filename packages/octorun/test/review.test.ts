import type { ReviewSnapshot } from '../src/review.ts'
import type { AgentProvider, EventEnvelope, JsonValue, PublicationEffect, RunRecord, TaskContext, TaskType } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { adversarialReviewPreset, createReviewTaskTypes, findingFingerprint, verifyReviewFindings } from '../src/review.ts'

const headSha = 'a'.repeat(40)
const baseSha = 'b'.repeat(40)
const snapshot = {
  headSha,
  baseSha,
  title: 'Handle a missing account',
  body: '',
  files: [{ path: 'src/account.ts', status: 'modified', truncated: false, patch: '@@ -1,2 +1,2 @@\n export function name(account) {\n-return account?.name\n+return account.name\n' }],
}
const candidate = { path: 'src/account.ts', side: 'RIGHT', line: 2, title: 'Handle missing accounts', body: 'A missing account now throws before the fallback can run.', evidence: 'return account.name', severity: 'high', confidence: 94 } as const
const event: EventEnvelope = {
  id: 'event',
  semanticKey: 'event',
  source: 'manual',
  name: 'pull_request',
  action: 'opened',
  repository: { id: 1, fullName: 'test/project', installationId: 2 },
  actor: { id: 3, login: 'maintainer', kind: 'User' },
  target: { _tag: 'PullRequest', number: 4, headSha, baseSha },
  occurredAt: '2026-10-21T00:00:00Z',
  receivedAt: '2026-10-21T00:00:00Z',
  data: {},
}

function harness(responses: (string | { error: true })[], previousFingerprints: string[] = [], snapshotValue: ReviewSnapshot = snapshot) {
  const effects: PublicationEffect[] = []
  const turns: string[] = []
  const provider: AgentProvider = {
    id: 'fixture',
    async generate(request) {
      turns.push(request.messages.map(message => message.content).join('\n'))
      const response = responses.shift()
      if (response === undefined)
        throw new Error('Unexpected paid turn')
      return typeof response === 'string'
        ? { _tag: 'Ok', value: { text: response, usage: { inputTokens: 20, outputTokens: 10, costUsd: null } } }
        : { _tag: 'Err', error: { _tag: 'Authorization', message: 'Fixture credentials rejected.' } }
    },
  }
  const types = createReviewTaskTypes({
    provider,
    snapshots: { read: async () => ({ _tag: 'Ok', value: snapshotValue }) },
    previousReview: async () => previousFingerprints.length ? { headSha: 'c'.repeat(40), baseSha, fingerprints: previousFingerprints } : null,
  })
  const definition = adversarialReviewPreset()
  const run: RunRecord = {
    id: 'run',
    event,
    definition,
    definitionDigest: 'digest',
    configuration: { source: 'fixture', sha: baseSha, digest: 'digest' },
    policy: { enabled: true, capabilities: ['repository:read', 'agent:invoke', 'github:comment', 'github:review'], maxConcurrency: 1 },
    state: { _tag: 'Running' },
    tasks: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    createdAt: event.receivedAt,
    updatedAt: event.receivedAt,
    startedAt: event.receivedAt,
    finishedAt: null,
  }
  const context: TaskContext = {
    run,
    event,
    outputs: {},
    signal: new AbortController().signal,
    task: { id: 'task', definition: definition.tasks[0]!, typeVersion: '1', state: { _tag: 'Running', leaseUntil: event.receivedAt }, attempts: 1, failures: 0, fence: 1, output: null, usage: run.usage, startedAt: event.receivedAt, finishedAt: null },
    publish: async (_key, effect) => {
      effects.push(effect)
      return { _tag: 'Ok', value: `publication-${effects.length}` }
    },
  }
  const execute = async (id: string, input: JsonValue) => {
    const task = types.find(task => task.id === id)!
    const parsed = task.input(input)
    if (parsed._tag === 'Err')
      throw new Error(parsed.error.message)
    return task.execute(context, parsed.value)
  }
  return { execute, context, effects, turns, types }
}

async function successful(task: ReturnType<ReturnType<typeof harness>['execute']>): Promise<JsonValue> {
  const result = await task
  expect(result._tag).toBe('Succeeded')
  if (result._tag !== 'Succeeded')
    throw new Error(JSON.stringify(result))
  return result.output
}

describe('adversarial review preset', () => {
  it('reviews, independently checks, deduplicates, and publishes one anchored finding', async () => {
    const h = harness([
      JSON.stringify({ findings: [candidate, { ...candidate, evidence: 'invented evidence' }] }),
      JSON.stringify({ findings: [{ ...candidate, title: 'Reject null accounts', confidence: 90 }] }),
      JSON.stringify({ accepted: ['correctness-0'] }),
    ])
    const selected = await successful(h.execute('review.snapshot', {}))
    const reviewed = await successful(h.execute('review.adversarial', { snapshot: selected }))
    const verified = await successful(h.execute('review.verify', { snapshot: selected, review: reviewed }))
    await successful(h.execute('review.publish', { report: verified }))
    expect(h.effects).toMatchObject([
      { _tag: 'Comment', body: expect.stringContaining('1 actionable finding') },
      { _tag: 'Review', headSha, comments: [{ path: 'src/account.ts', line: 2, side: 'RIGHT', body: expect.stringContaining('Handle missing accounts') }] },
    ])
    expect(h.effects.filter(effect => effect._tag === 'Review').flatMap(effect => effect.comments)).toHaveLength(1)
    expect(h.turns).toHaveLength(3)
    expect(verified).toMatchObject({ outcome: 'actionable', coverage: 'complete', rejected: 1 })
  })

  it('fails the task when a reviewer fails, without publishing a clean result', async () => {
    const h = harness([JSON.stringify({ findings: [] }), { error: true }])
    const selected = await successful(h.execute('review.snapshot', {}))
    expect(await h.execute('review.adversarial', { snapshot: selected })).toMatchObject({ _tag: 'Failed', error: { _tag: 'Authorization' } })
    expect(h.effects).toEqual([])
  })

  it('reports incomplete coverage when a patch is unavailable without spending model capacity', async () => {
    const h = harness([], [], { ...snapshot, files: [{ path: 'image.png', status: 'modified', patch: null, truncated: true }] })
    const selected = await successful(h.execute('review.snapshot', {}))
    const reviewed = await successful(h.execute('review.adversarial', { snapshot: selected }))
    const verified = await successful(h.execute('review.verify', { snapshot: selected, review: reviewed }))
    await successful(h.execute('review.publish', { report: verified }))
    expect(verified).toMatchObject({ outcome: 'incomplete', coverage: 'incomplete', findings: [] })
    expect(h.effects).toMatchObject([{ _tag: 'Comment', body: expect.stringContaining('scope is incomplete') }])
    expect(h.turns).toEqual([])
  })

  it('rejects a snapshot from another head before any agent turn', async () => {
    const h = harness([], [], { ...snapshot, headSha: 'd'.repeat(40) })
    expect(await h.execute('review.snapshot', {})).toMatchObject({ _tag: 'Failed', error: { _tag: 'Permanent' } })
    expect(h.turns).toEqual([])
  })

  it('suppresses unchanged findings on an incremental review and retains their result', async () => {
    const fingerprint = findingFingerprint(candidate)
    const h = harness([JSON.stringify({ findings: [candidate] }), JSON.stringify({ findings: [] }), JSON.stringify({ accepted: ['correctness-0'] })], [fingerprint])
    const selected = await successful(h.execute('review.snapshot', {}))
    const reviewed = await successful(h.execute('review.adversarial', { snapshot: selected }))
    const verified = await successful(h.execute('review.verify', { snapshot: selected, review: reviewed }))
    await successful(h.execute('review.publish', { report: verified }))
    expect(verified).toMatchObject({ outcome: 'actionable', repeated: 1, findings: [{ fingerprint }] })
    expect(h.effects).toHaveLength(1)
    expect(h.effects[0]).toMatchObject({ _tag: 'Comment', body: expect.stringContaining('already reported') })
  })

  it('rejects invented evidence and keeps a fingerprint stable after line movement', () => {
    const findings = verifyReviewFindings(snapshot, [
      { ...candidate, id: 'real' },
      { ...candidate, id: 'invented', evidence: 'not in the patch' },
      { ...candidate, id: 'outside', line: 500 },
    ])
    expect(findings.findings).toMatchObject([{ id: 'real', evidenceKind: 'static' }])
    expect(findings.rejected).toBe(2)
    const moved = { ...candidate, line: 42 }
    expect(findingFingerprint(moved)).toBe(findingFingerprint(candidate))
  })

  it('answers a finding question in its existing thread without starting another review', async () => {
    const h = harness(['The missing account throws when this line reads its name. Add the optional access again.'])
    await successful(h.execute('review.conversation', { conversation: { commentId: 52, question: 'Why does this fail?', reviewedHeadSha: headSha, finding: candidate, history: [] } }))
    expect(h.effects).toMatchObject([{ _tag: 'Reply', commentId: 52, body: expect.stringContaining('missing account') }])
    expect(h.turns).toHaveLength(1)
  })
})

describe('custom change summary chain', () => {
  it('classifies files, generates a summary, and publishes a comment without review state', async () => {
    const h = harness(['Handle account names directly.'])
    const changes = await successful(h.execute('changes.classify', {}))
    const summary = await successful(h.execute('changes.summarize', { changes }))
    await successful(h.execute('changes.comment', { summary }))
    expect(changes).toMatchObject({ files: [{ path: 'src/account.ts', category: 'source' }] })
    expect(h.effects).toMatchObject([{ _tag: 'Comment', namespace: 'change-summary', body: 'Handle account names directly.' }])
  })

  it('refuses malformed task inputs before requesting an agent turn', () => {
    const h = harness([])
    const type = h.types.find(type => type.id === 'review.conversation') as TaskType
    expect(type.input({ conversation: { commentId: -1, question: '' } })).toMatchObject({ _tag: 'Err' })
    expect(h.turns).toEqual([])
  })
})
