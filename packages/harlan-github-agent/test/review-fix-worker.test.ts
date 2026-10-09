import type { ClaimedReviewFixTask, ReviewFinding } from '../src/types.ts'
import type { ProviderCapture } from './fixtures.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { err, ok } from '../src/result.ts'
import { createReviewFixWorker } from '../src/review-fix-worker.ts'
import { agentRuntime, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

describe('review fix Worker', () => {
  it('preserves the next action when Repair returns no file changes', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const mapping = repositoryMapping({ ownership: 'maintained' })
    const task: ClaimedReviewFixTask = {
      id: 'repair-task',
      kind: 'review_fix',
      repository: mapping.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'repair-worker', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: mapping,
      pullRequest,
      rounds: { number: 1, limit: 3, prior: [] },
    }
    const findings: ReviewFinding[] = [{
      _tag: 'Open',
      summary: 'The parser drops buffered bytes.',
      nextAction: 'Preserve all buffered bytes.',
      details: {
        fingerprint: 'f'.repeat(64),
        location: { path: 'src/parser.ts', line: 42 },
        proof: 'A split UTF-8 sequence loses its first byte.',
        regressionTest: 'Split one UTF-8 sequence across two chunks and assert the original string.',
      },
    }]
    const capture: ProviderCapture = { requests: [] }
    let committedMessage = ''

    const result = await createReviewFixWorker({
      github: {
        getFailedJobContext: () => Promise.resolve(ok({ runId: 42, jobName: 'test', failedStep: 'focused test', logTail: ['Private controller log: missing generated inputs'], execution: [{ run: 'pnpm dev:prepare', shell: 'bash -e {0}', workingDirectory: 'packages/site' }] })),
        findOpenPullRequestForBranch: () => Promise.resolve(ok(null)),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [] },
          body: '',
          checks: { _tag: 'Available', checks: [{ id: 42, name: 'test', status: 'completed', conclusion: 'failure', failure: { _tag: 'StepFailed' }, source: { _tag: 'CheckRun', appId: 15368 } }] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          findingDiscussions: [],
          requiredChecks: { _tag: 'None' },
          reviews: [],
        })),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        outcome: 'repaired',
        summary: 'Update the pull request description to match the severity routing.',
        checks: ['Compared the description with the head diff.'],
        commitMessage: 'fix(parser): preserve buffered bytes',
      }), capture)),
      status: { publishRepair: () => Promise.resolve(ok(undefined)) },
      store: {
        getReviewFixFindings: () => findings,
        recordRepairReport: () => true,
        getWorkerSession: () => 'review-session-must-not-resume',
        requestReviewRerun: () => { throw new Error('A successful Repair must not queue another Review.') },
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(mapping)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/repair-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 0 })),
        commit: (_task, _workspace, _patch, message) => {
          committedMessage = message
          return Promise.resolve(ok({
            commitSha: 'repair-commit',
            baseSha: pullRequest.baseSha,
            artifactRef: 'artifact-ref',
            digest: 'patch-digest',
            changedFiles: 2,
          }))
        },
      },
    }).run(task, new AbortController().signal)

    expect(result).toEqual(ok({
      _tag: 'ActionRequired',
      reason: 'Repair produced no file changes. Update the pull request description to match the severity routing.',
      evidence: JSON.stringify({ findings, checks: ['Compared the description with the head diff.'] }),
      usage: { _tag: 'Unavailable' },
    }))
    expect(committedMessage).toBe('')
    expect(capture.requests[0]?.prompt).toContain('Private controller log: missing generated inputs')
    expect(capture.requests[0]?.prompt).toContain('pnpm dev:prepare')
  })

  it.each([
    { merged: false, outcome: 'repaired', existing: false },
    { merged: false, outcome: 'repaired', existing: false, ownerRequest: true },
    { merged: false, outcome: 'disputed', existing: false, ownerRequest: true },
    { merged: true, outcome: 'repaired', existing: false },
    { merged: true, outcome: 'disputed', existing: false },
    { merged: true, outcome: 'blocked', existing: false },
    { merged: true, outcome: 'repaired', existing: true },
    { merged: true, outcome: 'repaired', existing: false, pickup: true },
    { merged: true, outcome: 'disputed', existing: false, pickup: true },
    { merged: true, outcome: 'repaired', existing: true, pickup: true },
  ])('repairs stored findings: %j', async ({ merged, outcome, existing, pickup, ownerRequest }) => {
    const pullRequest = pullRequestItem({ mergeState: 'clean', ...(merged ? { state: 'closed', mergedAt: '2026-08-13T00:59:00.000Z' } as const : {}) })
    const mapping = repositoryMapping({ ownership: ownerRequest ? 'owned' : 'maintained' })
    const task: ClaimedReviewFixTask = {
      id: 'repair-task',
      kind: 'review_fix',
      repository: mapping.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'repair-worker', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: mapping,
      pullRequest,
      rounds: { number: 1, limit: 3, prior: [] },
    }
    const findings: ReviewFinding[] = [{
      _tag: 'Open',
      summary: 'The parser drops buffered bytes.',
      nextAction: 'Preserve all buffered bytes.',
      details: {
        fingerprint: 'f'.repeat(64),
        location: { path: 'src/parser.ts', line: 42 },
        proof: 'A split UTF-8 sequence loses its first byte.',
        regressionTest: 'Split one UTF-8 sequence across two chunks and assert the original string.',
      },
    }]
    if (pickup) {
      task.pickup = { _tag: 'LoggedFinding', finding: {
        _tag: 'Logged',
        impact: 40,
        summary: 'The parser drops buffered bytes.',
        details: { fingerprint: 'f'.repeat(64), identity: 'buffered bytes', location: { path: 'src/parser.ts', line: 42 }, proof: 'Split one UTF-8 sequence across two chunks and observe dropped bytes.' },
      } }
    }
    if (ownerRequest)
      task.request = { _tag: 'OwnerComment', instruction: 'Change trailingSlash to false.', requestedBy: 'harlan-zw', requestId: 'comment:42' }
    const capture: ProviderCapture = { requests: [] }
    let committedMessage = ''

    const result = await createReviewFixWorker({
      github: {
        findOpenPullRequestForBranch: () => Promise.resolve(ok(existing ? { number: 25, url: 'https://github.com/harlan-zw/example/pull/25' } : null)),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [] },
          body: '',
          checks: { _tag: 'Available', checks: [] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          findingDiscussions: [],
          requiredChecks: { _tag: 'None' },
          reviews: [],
        })),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        outcome,
        summary: 'Preserved buffered bytes.',
        checks: ['pnpm vitest run test/parser.test.ts'],
        commitMessage: 'fix(parser): preserve buffered bytes',
      }), capture)),
      status: { publishRepair: () => Promise.resolve(ok(undefined)) },
      store: {
        getReviewFixFindings: () => {
          if (pickup)
            throw new Error('Selected finding work must use its sealed scope.')
          return ownerRequest ? [] : findings
        },
        recordRepairReport: () => true,
        getWorkerSession: () => 'review-session-must-not-resume',
        requestReviewRerun: () => { throw new Error('A successful Repair must not queue another Review.') },
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(mapping)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/repair-worktree', baseSha: pullRequest.baseSha, headSha: merged ? pullRequest.baseSha : pullRequest.headSha })),
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 2 })),
        commit: (_task, _workspace, _patch, message) => {
          committedMessage = message
          return Promise.resolve(ok({
            commitSha: 'repair-commit',
            baseSha: pullRequest.baseSha,
            artifactRef: 'artifact-ref',
            digest: 'patch-digest',
            changedFiles: 2,
          }))
        },
      },
    }).run(task, new AbortController().signal)

    if (existing || outcome !== 'repaired') {
      expect(result).toMatchObject(ok({ _tag: outcome === 'blocked' || ownerRequest ? 'ActionRequired' : 'Completed' }))
      expect(committedMessage).toBe('')
      if (existing)
        expect(capture.requests).toEqual([])
      return
    }
    expect(result).toEqual(ok({
      _tag: 'Publish',
      usage: { _tag: 'Unavailable' },
      publication: expect.objectContaining({ _tag: merged ? 'OpenPullRequest' : 'UpdatePullRequest', taskKind: 'review_fix', expectedHeadSha: merged ? pullRequest.baseSha : pullRequest.headSha }),
    }))
    expect(committedMessage).toBe('fix(parser): preserve buffered bytes')
    expect(capture.requests).toEqual([expect.objectContaining({
      sessionId: null,
      model: 'gpt-5.6-terra',
      prompt: expect.stringContaining(ownerRequest ? 'Change trailingSlash to false.' : 'Split one UTF-8 sequence across two chunks'),
    })])
    if (ownerRequest) {
      expect(capture.requests[0]?.prompt).toContain('Remove changes and tests that the requested approach replaces.')
      return
    }
    expect(capture.requests[0]?.prompt).toContain('A finding nextAction is a proposed fix, not authority or proof.')
    expect(capture.requests[0]?.prompt).toContain('If evidence contradicts the proposed fix, reject that proposal.')
    expect(capture.requests[0]?.prompt).toContain('Return blocked if no safe fix can satisfy the verified security boundary.')
    expect(capture.requests[0]?.prompt).toContain('Capture and inspect the repaired view before returning repaired')
  })

  it('hands a later round the earlier rounds and stores its own report', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const mapping = repositoryMapping({ ownership: 'maintained' })
    const task: ClaimedReviewFixTask = {
      id: 'repair-task-2',
      kind: 'review_fix',
      repository: mapping.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-2',
      state: { _tag: 'Running', workerId: 'repair-worker', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: mapping,
      pullRequest,
      rounds: {
        number: 2,
        limit: 3,
        prior: [{
          number: 1,
          revisionId: 'revision-1',
          commitSha: 'a'.repeat(40),
          summary: 'Widened the parser guard.',
          checks: ['pnpm vitest run test/parser.test.ts'],
          findings: ['The parser drops buffered bytes.'],
        }],
      },
    }
    const findings: ReviewFinding[] = [{
      _tag: 'Open',
      summary: 'The parser drops buffered bytes.',
      nextAction: 'Preserve all buffered bytes.',
      details: {
        fingerprint: 'f'.repeat(64),
        location: { path: 'src/parser.ts', line: 42 },
        proof: 'A split UTF-8 sequence still loses its first byte after the widened guard.',
        regressionTest: 'Split one UTF-8 sequence across two chunks and assert the original string.',
      },
    }]
    const capture: ProviderCapture = { requests: [] }
    const reports: Array<{ summary: string, checks: string[] }> = []

    const result = await createReviewFixWorker({
      github: {
        findOpenPullRequestForBranch: () => Promise.resolve(ok(null)),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [] },
          body: '',
          checks: { _tag: 'Available', checks: [] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          findingDiscussions: [],
          requiredChecks: { _tag: 'None' },
          reviews: [],
        })),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        outcome: 'repaired',
        summary: 'Buffered the partial sequence across chunks.',
        checks: ['pnpm vitest run test/parser.test.ts'],
        commitMessage: 'fix(parser): buffer partial sequences',
      }), capture)),
      status: { publishRepair: () => Promise.resolve(ok(undefined)) },
      store: {
        getReviewFixFindings: () => findings,
        getWorkerSession: () => null,
        recordRepairReport: (input) => {
          reports.push({ summary: input.summary, checks: input.checks })
          return true
        },
        requestReviewRerun: () => { throw new Error('A successful Repair must not queue another Review.') },
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(mapping)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/repair-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 2 })),
        commit: () => Promise.resolve(ok({
          commitSha: 'repair-commit-2',
          baseSha: pullRequest.baseSha,
          artifactRef: 'artifact-ref',
          digest: 'patch-digest',
          changedFiles: 2,
        })),
      },
    }).run(task, new AbortController().signal)

    expect(result).toMatchObject({ _tag: 'Ok', value: { _tag: 'Publish' } })
    const prompt = capture.requests[0]?.prompt ?? ''
    expect(prompt).toContain('This is Repair round 2 of 3.')
    expect(prompt).toContain(`Round 1 published commit ${'a'.repeat(40)}.`)
    expect(prompt).toContain('Its Repair Agent reported: Widened the parser guard.')
    expect(prompt).toContain('Treat every earlier approach as rejected.')
    expect(reports).toEqual([{ summary: 'Buffered the partial sequence across chunks.', checks: ['pnpm vitest run test/parser.test.ts'] }])
  })

  it.each([
    { label: 'bare JSON', response: null, rejection: null },
    { label: 'brace-bearing prose and fenced JSON', response: 'The cast to { fonts?: ... } is safe.\n```json\n{"outcome":"disputed","summary":"The false branch already adds LIMIT 100.","checks":["pnpm vitest run test/dashboard-history-limit.test.ts"],"commitMessage":""}\n```', rejection: null },
    { label: 'repeated checks strings', response: 'The cast to { fonts?: ... } is safe.\n{"outcome":"disputed","summary":"Verified.","checks":"first command","checks":"second command","commitMessage":""}', rejection: 'duplicate object keys' },
    { label: 'escaped repeated keys', response: '{"outcome":"disputed","summary":"Verified.","checks":[],"\\u0063hecks":[],"commitMessage":""}', rejection: 'duplicate object keys' },
    { label: 'checks string', response: '{"outcome":"disputed","summary":"Verified.","checks":"command","commitMessage":""}', rejection: 'invalid Repair result' },
    { label: 'missing outcome', response: '{"summary":"Verified.","checks":[],"commitMessage":""}', rejection: 'invalid Repair result' },
    { label: 'missing summary', response: '{"outcome":"disputed","checks":[],"commitMessage":""}', rejection: 'invalid Repair result' },
    { label: 'missing checks', response: '{"outcome":"disputed","summary":"Verified.","commitMessage":""}', rejection: 'invalid Repair result' },
    { label: 'missing commitMessage', response: '{"outcome":"disputed","summary":"Verified.","checks":[]}', rejection: 'invalid Repair result' },
    { label: 'unknown field', response: '{"outcome":"disputed","summary":"Verified.","checks":[],"commitMessage":"","unexpected":true}', rejection: 'invalid Repair result' },
    { label: 'null result', response: 'null', rejection: 'invalid Repair result' },
    { label: 'array result', response: '[{"outcome":"disputed","summary":"Verified.","checks":[],"commitMessage":""}]', rejection: 'invalid Repair result' },
    { label: 'fenced array result', response: '```json\n[{"outcome":"disputed","summary":"Verified.","checks":[],"commitMessage":""}]\n```', rejection: 'invalid Repair result' },
    { label: 'prose and fenced array result', response: 'The cast to { fonts?: ... } is safe.\n```json\n[{"outcome":"disputed","summary":"Verified.","checks":[],"commitMessage":""}]\n```', rejection: 'invalid Repair result' },
    { label: 'prose and array result', response: 'Here is the result:\n[{"outcome":"disputed","summary":"Verified.","checks":[],"commitMessage":""}]', rejection: 'invalid Repair result' },
    { label: 'fenced string result', response: '```json\n"{\\"outcome\\":\\"disputed\\",\\"summary\\":\\"Verified.\\",\\"checks\\":[],\\"commitMessage\\":\\"\\"}"\n```', rejection: 'invalid Repair result' },
    { label: 'unclosed array wrapper', response: '[{"outcome":"disputed","summary":"Verified.","checks":[],"commitMessage":""}', rejection: 'malformed Repair JSON' },
    { label: 'mismatched array wrapper', response: '[{"outcome":"disputed","summary":"Verified.","checks":[],"commitMessage":""}}', rejection: 'malformed Repair JSON' },
    { label: 'unmatched leading array closer', response: ']{"outcome":"disputed","summary":"Verified.","checks":[],"commitMessage":""}', rejection: 'malformed Repair JSON' },
    { label: 'unmatched trailing array closer', response: '{"outcome":"disputed","summary":"Verified.","checks":[],"commitMessage":""}]', rejection: 'malformed Repair JSON' },
    { label: 'unmatched leading object closer', response: '}{"outcome":"disputed","summary":"Verified.","checks":[],"commitMessage":""}', rejection: 'malformed Repair JSON' },
    { label: 'unmatched trailing object closer', response: '{"outcome":"disputed","summary":"Verified.","checks":[],"commitMessage":""}}', rejection: 'malformed Repair JSON' },
  ])('queues one fresh Review after parsing or correcting $label', async ({ response, rejection }) => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const mapping = repositoryMapping({ ownership: 'maintained' })
    const task: ClaimedReviewFixTask = {
      id: 'repair-task-disputed',
      kind: 'review_fix',
      repository: mapping.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'repair-worker', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: mapping,
      pullRequest,
      rounds: { number: 1, limit: 3, prior: [] },
    }
    const findings: ReviewFinding[] = [{
      _tag: 'Open',
      summary: 'The history query has no limit.',
      nextAction: 'Limit the history query.',
      details: {
        fingerprint: 'f'.repeat(64),
        location: { path: 'src/store.ts', line: 42 },
        proof: 'The false branch omits LIMIT 100.',
        regressionTest: 'Seed old history and assert only 100 rows are read.',
      },
    }]
    const reruns: unknown[] = []
    const requests: ProviderCapture = { requests: [] }
    const valid = JSON.stringify({
      outcome: 'disputed',
      summary: 'The false branch already adds LIMIT 100.',
      checks: ['pnpm vitest run test/dashboard-history-limit.test.ts'],
      commitMessage: '',
    })

    const result = await createReviewFixWorker({
      github: {
        findOpenPullRequestForBranch: () => Promise.resolve(ok(null)),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [] },
          body: '',
          checks: { _tag: 'Available', checks: [] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          findingDiscussions: [],
          requiredChecks: { _tag: 'None' },
          reviews: [],
        })),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, {
        name: 'opencode',
        runTurn: (request) => {
          requests.requests.push(request)
          return (async function* () {
            yield { _tag: 'SessionStarted' as const, sessionId: 'repair-session' }
            yield { _tag: 'Message' as const, text: requests.requests.length === 1 ? response ?? valid : valid }
            yield { _tag: 'TurnCompleted' as const }
          })()
        },
      }),
      status: { publishRepair: () => Promise.resolve(ok(undefined)) },
      store: {
        getReviewFixFindings: () => findings,
        recordRepairReport: () => true,
        getWorkerSession: () => null,
        requestReviewRerun: (input) => {
          reruns.push(input)
          return { _tag: 'Queued', taskId: 'review-task' }
        },
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(mapping)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/repair-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
        verify: () => { throw new Error('A disputed finding must not produce a patch.') },
        commit: () => { throw new Error('A disputed finding must not produce a commit.') },
      },
    }).run(task, new AbortController().signal)

    expect(result).toEqual(ok({
      _tag: 'ActionRequired',
      usage: { _tag: 'Unavailable' },
      reason: 'Repair disputed the finding. One fresh Review was queued: The false branch already adds LIMIT 100.',
      evidence: JSON.stringify({ findings, checks: ['pnpm vitest run test/dashboard-history-limit.test.ts'] }),
    }))
    expect(reruns).toEqual([{
      repository: mapping.github,
      pullRequestNumber: pullRequest.number,
      revisionId: task.revisionId,
      requestId: expect.stringMatching(/^repair-dispute:repair-task-disputed:[0-9a-f]{64}$/),
      source: 'repair_dispute',
      requestedBy: 'review_fix',
      at: '2026-08-13T01:00:00.000Z',
    }])
    expect(requests.requests).toHaveLength(rejection === null ? 1 : 2)
    expect(requests.requests[0]?.sessionId).toBeNull()
    if (rejection !== null) {
      expect(requests.requests[1]?.sessionId).toBe('repair-session')
      expect(requests.requests[1]?.prompt).toContain(rejection)
      expect(requests.requests[1]?.prompt).toContain('Use no tool.')
      expect(requests.requests[1]?.prompt).not.toContain('Repair the exact material Review findings')
    }
  })

  it('gives each distinct dispute set its own rerun request', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const mapping = repositoryMapping({ ownership: 'maintained' })
    const task: ClaimedReviewFixTask = {
      id: 'repair-task-disputed',
      kind: 'review_fix',
      repository: mapping.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'repair-worker', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: mapping,
      pullRequest,
      rounds: { number: 1, limit: 3, prior: [] },
    }
    const openFinding = (fingerprint: string): ReviewFinding => ({
      _tag: 'Open',
      summary: `Finding ${fingerprint.slice(0, 4)}.`,
      nextAction: 'Fix it.',
      details: {
        fingerprint,
        location: { path: 'src/store.ts', line: 42 },
        proof: 'The false branch omits LIMIT 100.',
        regressionTest: null,
      },
    })
    const snapshot = () => Promise.resolve(ok({
      baseChecks: { _tag: 'Available' as const, checks: [] },
      body: '',
      checks: { _tag: 'Available' as const, checks: [] },
      comments: [],
      priorAutomatedReview: { _tag: 'None' } as const,
      pullRequest,
      findingDiscussions: [],
      requiredChecks: { _tag: 'None' } as const,
      reviews: [],
    }))
    const run = async (findings: ReviewFinding[]) => {
      const reruns: string[] = []
      await createReviewFixWorker({
        github: { findOpenPullRequestForBranch: () => Promise.resolve(ok(null)), getPullRequestReviewSnapshot: snapshot },
        now: () => new Date('2026-08-13T01:00:00.000Z'),
        runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
          outcome: 'disputed',
          summary: 'The false branch already adds LIMIT 100.',
          checks: [],
          commitMessage: '',
        }))),
        status: { publishRepair: () => Promise.resolve(ok(undefined)) },
        store: {
          getReviewFixFindings: () => findings,
          recordRepairReport: () => true,
          getWorkerSession: () => null,
          requestReviewRerun: (input) => {
            reruns.push(input.requestId)
            return { _tag: 'Queued', taskId: 'review-task' }
          },
          saveWorkerSession: () => undefined,
          updateAgentProgress: () => true,
        },
        validateMapping: () => Promise.resolve(ok(mapping)),
        worktrees: {
          prepare: () => Promise.resolve(ok({ path: '/tmp/repair-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
          verify: () => { throw new Error('A disputed finding must not produce a patch.') },
          commit: () => { throw new Error('A disputed finding must not produce a commit.') },
        },
      }).run(task, new AbortController().signal)
      return reruns
    }

    const firstDispute = await run([openFinding('a'.repeat(64))])
    const repeatedDispute = await run([openFinding('a'.repeat(64))])
    const secondDispute = await run([openFinding('b'.repeat(64))])

    expect(firstDispute[0]).toMatch(/^repair-dispute:repair-task-disputed:[0-9a-f]{64}$/)
    expect(secondDispute[0]).not.toBe(firstDispute[0])
    expect(repeatedDispute[0]).toBe(firstDispute[0])
  })

  it('routes a capped second disagreement to action without another Review', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const mapping = repositoryMapping({ ownership: 'maintained' })
    const task: ClaimedReviewFixTask = {
      id: 'repair-task-dispute-capped',
      kind: 'review_fix',
      repository: mapping.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'repair-worker', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: mapping,
      pullRequest,
      rounds: { number: 1, limit: 3, prior: [] },
    }
    const findings: ReviewFinding[] = [{
      _tag: 'Open',
      summary: 'The history query has no limit.',
      nextAction: 'Limit the history query.',
      details: {
        fingerprint: 'b'.repeat(64),
        location: { path: 'src/store.ts', line: 42 },
        proof: 'The false branch omits LIMIT 100.',
        regressionTest: null,
      },
    }]

    const result = await createReviewFixWorker({
      github: {
        findOpenPullRequestForBranch: () => Promise.resolve(ok(null)),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [] },
          body: '',
          checks: { _tag: 'Available', checks: [] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          findingDiscussions: [],
          requiredChecks: { _tag: 'None' },
          reviews: [],
        })),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        outcome: 'disputed',
        summary: 'The false branch already adds LIMIT 100.',
        checks: [],
        commitMessage: '',
      }))),
      status: { publishRepair: () => Promise.resolve(ok(undefined)) },
      store: {
        getReviewFixFindings: () => findings,
        recordRepairReport: () => true,
        getWorkerSession: () => null,
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'DisputeCapReached' } }),
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(mapping)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/repair-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
        verify: () => { throw new Error('A disputed finding must not produce a patch.') },
        commit: () => { throw new Error('A disputed finding must not produce a commit.') },
      },
    }).run(task, new AbortController().signal)

    expect(result).toEqual(ok({
      _tag: 'ActionRequired',
      usage: { _tag: 'Unavailable' },
      reason: 'Repair and the fresh Review still disagree: The false branch already adds LIMIT 100.',
      evidence: JSON.stringify({ findings, checks: [] }),
    }))
  })

  it('rejects a blocked result with an empty summary', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const mapping = repositoryMapping({ ownership: 'maintained' })
    const task: ClaimedReviewFixTask = {
      id: 'repair-task-empty-summary',
      kind: 'review_fix',
      repository: mapping.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'repair-worker', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: mapping,
      pullRequest,
      rounds: { number: 1, limit: 3, prior: [] },
    }
    const findings: ReviewFinding[] = [{
      _tag: 'Open',
      summary: 'The parser drops buffered bytes.',
      nextAction: 'Preserve all buffered bytes.',
      details: {
        fingerprint: 'f'.repeat(64),
        location: { path: 'src/parser.ts', line: 42 },
        proof: 'A split UTF-8 sequence loses its first byte.',
        regressionTest: 'Split one UTF-8 sequence across two chunks and assert the original string.',
      },
    }]
    const capture: ProviderCapture = { requests: [] }

    const result = await createReviewFixWorker({
      github: {
        findOpenPullRequestForBranch: () => Promise.resolve(ok(null)),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [] },
          body: '',
          checks: { _tag: 'Available', checks: [] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          findingDiscussions: [],
          requiredChecks: { _tag: 'None' },
          reviews: [],
        })),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        outcome: 'blocked',
        summary: '',
        checks: [],
        commitMessage: '',
      }), capture)),
      status: { publishRepair: () => Promise.resolve(ok(undefined)) },
      store: {
        getReviewFixFindings: () => findings,
        recordRepairReport: () => true,
        getWorkerSession: () => null,
        requestReviewRerun: () => { throw new Error('An invalid result must not queue another Review.') },
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(mapping)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/repair-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 2 })),
        commit: () => Promise.resolve(ok({
          commitSha: 'repair-commit',
          baseSha: pullRequest.baseSha,
          artifactRef: 'artifact-ref',
          digest: 'patch-digest',
          changedFiles: 2,
        })),
      },
    }).run(task, new AbortController().signal)

    expect(result).toEqual(err('The agent repeated a rejected result after one named correction. The Agent returned an invalid Repair result.'))
    expect(capture.requests).toHaveLength(2)
    expect(capture.requests[1]?.prompt).toContain('schema')
  })
})
