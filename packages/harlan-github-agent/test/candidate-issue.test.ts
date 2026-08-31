import type { GitHubIssuePublisher } from '../src/github.ts'
import type { Candidate, ClaimedRoutineRun } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { candidateIssueBody, candidateIssueCommands, createCandidateIssueController, routineIssueLabel } from '../src/candidate-issue-controller.ts'
import { err, ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { repositoryMapping } from './fixtures.ts'

const now = () => new Date('2026-08-27T07:10:00.000Z')

const routine: ClaimedRoutineRun = {
  id: 'harlan-zw/example:pr-triage:2026-08-27T07:00:00.000Z',
  routineId: 'harlan-zw/example:pr-triage',
  repository: 'harlan-zw/example',
  repositoryMapping: repositoryMapping(),
  name: 'pr-triage',
  mode: 'propose',
  scheduledFor: '2026-08-27T07:00:00.000Z',
  specSha: 'abc123',
  attempts: 1,
  state: { _tag: 'Running', fence: 1, workerId: 'worker-1', leaseExpiresAt: '2026-08-27T08:00:00.000Z' },
}

const candidate: Candidate = {
  id: 'candidate-1',
  routineId: routine.routineId,
  runId: routine.id,
  fingerprint: 'src/store.ts#openRoutineRun',
  target: 'src/store.ts',
  claim: 'This helper is never called.',
  verification: 'pnpm test',
  estimatedChangedFiles: 1,
  result: { _tag: 'Proposed', pullRequest: null },
  createdAt: '2026-08-27T07:05:00.000Z',
  updatedAt: '2026-08-27T07:05:00.000Z',
}

function seed(store: ReturnType<typeof openJournalStore>): void {
  store.syncRepositories([repositoryMapping()], '2026-08-27T00:00:00.000Z')
  store.setRepositoryWritesEnabled('harlan-zw/example', true)
  store.syncRoutines({
    repository: 'harlan-zw/example',
    specSha: 'abc123',
    entries: [{ name: 'pr-triage', crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'propose', enabled: true }],
    at: '2026-08-27T00:00:00.000Z',
  })
  store.openRoutineRun({
    routineId: routine.routineId,
    scheduledFor: routine.scheduledFor,
    specSha: 'abc123',
    at: '2026-08-27T07:00:05.000Z',
  })
  store.recordCandidates({
    routineId: routine.routineId,
    runId: routine.id,
    candidates: [{
      fingerprint: candidate.fingerprint,
      target: candidate.target,
      claim: candidate.claim,
      verification: candidate.verification,
      estimatedChangedFiles: candidate.estimatedChangedFiles,
    }],
    at: '2026-08-27T07:05:00.000Z',
  })
}

function publisher(calls: Array<{ title: string, labels?: readonly string[] }>): GitHubIssuePublisher {
  return {
    findOpenIssueByFingerprint: () => Promise.resolve(ok(null)),
    findRoutineTrackingIssue: () => Promise.resolve(ok(null)),
    findIssueCommentByMarker: () => Promise.resolve(ok(null)),
    createComment: async () => ok({ id: 1 }),
    createIssue: async (input) => {
      calls.push({ title: input.title, ...(input.labels === undefined ? {} : { labels: input.labels }) })
      return ok({ number: 100 + calls.length, url: `https://github.com/harlan-zw/example/issues/${100 + calls.length}` })
    },
  }
}

describe('writing the issue a Candidate proposes', () => {
  it('carries the claim, the target, and the command that proves it', () => {
    const body = candidateIssueBody(candidate, routine)

    expect(body).toContain('This helper is never called.')
    expect(body).toContain('src/store.ts')
    expect(body).toContain('pnpm test')
  })

  it('identifies itself as automated and says how to reject it', () => {
    const body = candidateIssueBody(candidate, routine)

    expect(body).toContain('opened this issue automatically')
    expect(body).toContain('Close it to reject')
  })

  it('hides the fingerprint in a comment, because nobody reads one', () => {
    expect(candidateIssueBody(candidate, routine)).toContain('<!-- candidate-fingerprint: src/store.ts#openRoutineRun -->')
  })

  it('labels every routine issue by its routine', () => {
    expect(routineIssueLabel('sentry-checkin')).toBe('routine:sentry-checkin')
  })

  it('caps the title and body so GitHub accepts them', () => {
    const wordy: Candidate = { ...candidate, claim: `never called. ${'word '.repeat(20_000)}` }
    const [command] = candidateIssueCommands([wordy], routine)
    if (command === undefined)
      throw new Error('one command per Candidate')

    expect(command.title.length).toBeLessThanOrEqual(256)
    expect(command.body.length).toBeLessThanOrEqual(65_536)
  })

  it('names one command per Candidate', () => {
    expect(candidateIssueCommands([candidate], routine)).toEqual([expect.objectContaining({
      candidateId: 'candidate-1',
      repository: 'harlan-zw/example',
      routineName: 'pr-triage',
    })])
  })
})

describe('filing the issues Candidates propose', () => {
  it('files a pending request and records the issue it opened', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const stored = store.listCandidates(routine.routineId)
      store.stageCandidateIssues({ commands: candidateIssueCommands(stored, routine), at: now().toISOString() })
      const calls: Array<{ title: string, labels?: readonly string[] }> = []

      const results = await createCandidateIssueController({
        github: publisher(calls),
        now,
        store,
        workerId: 'controller-1',
      }).publishPending(new AbortController().signal)

      expect(results).toEqual([{ _tag: 'Ok', value: { repository: 'harlan-zw/example', issueNumber: 101 } }])
      expect(calls[0]?.labels).toEqual(['routine:pr-triage'])
      expect(store.getRoutineIssueSource('harlan-zw/example', 101)).toEqual({
        routineName: 'pr-triage',
        target: 'src/store.ts',
      })
    }
    finally {
      store.close()
    }
  })

  it('files one issue per Candidate however often it is asked', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      const stored = store.listCandidates(routine.routineId)
      const commands = candidateIssueCommands(stored, routine)

      const first = store.stageCandidateIssues({ commands, at: now().toISOString() })
      const second = store.stageCandidateIssues({ commands, at: now().toISOString() })

      expect(first).toBe(1)
      expect(second).toBe(0)
    }
    finally {
      store.close()
    }
  })

  it('stops at the limit, so one scan cannot flood a repository', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      store.recordCandidates({
        routineId: routine.routineId,
        runId: routine.id,
        candidates: Array.from({ length: 8 }, (_unused, index) => ({
          fingerprint: `src/file-${index}.ts`,
          target: `src/file-${index}.ts`,
          claim: 'unused',
          verification: 'pnpm test',
          estimatedChangedFiles: 1,
        })),
        at: '2026-08-27T07:05:00.000Z',
      })
      store.stageCandidateIssues({
        commands: candidateIssueCommands(store.listCandidates(routine.routineId), routine),
        at: now().toISOString(),
      })
      const calls: Array<{ title: string }> = []

      const results = await createCandidateIssueController({
        github: publisher(calls),
        now,
        store,
        workerId: 'controller-1',
      }).publishPending(new AbortController().signal, 3)

      expect(results).toHaveLength(3)
    }
    finally {
      store.close()
    }
  })

  it('retries a refused request on the next pass', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      store.stageCandidateIssues({
        commands: candidateIssueCommands(store.listCandidates(routine.routineId), routine),
        at: now().toISOString(),
      })
      const refusing = {
        findOpenIssueByFingerprint: () => Promise.resolve(ok(null)),
        createComment: async () => ok({ id: 1 }),
        createIssue: async () => ({ _tag: 'Err' as const, error: { repository: 'harlan-zw/example', message: 'GitHub returned 502.' } }),
      }
      const controller = createCandidateIssueController({ github: refusing, now, store, workerId: 'controller-1' })

      const failed = await controller.publishPending(new AbortController().signal, 1)
      const calls: Array<{ title: string }> = []
      const retried = await createCandidateIssueController({
        github: publisher(calls),
        now,
        store,
        workerId: 'controller-1',
      }).publishPending(new AbortController().signal, 1)

      expect(failed[0]?._tag).toBe('Err')
      expect(retried[0]).toMatchObject({ _tag: 'Ok' })
    }
    finally {
      store.close()
    }
  })

  it('creates nothing when duplicate detection cannot read GitHub', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      store.stageCandidateIssues({
        commands: candidateIssueCommands(store.listCandidates(routine.routineId), routine),
        at: now().toISOString(),
      })
      let created = 0
      const results = await createCandidateIssueController({
        github: {
          findOpenIssueByFingerprint: () => Promise.resolve(err({ repository: 'harlan-zw/example', message: 'GitHub timed out.' })),
          createIssue: async () => {
            created += 1
            return ok({ number: 7, url: 'https://github.com/harlan-zw/example/issues/7' })
          },
        },
        now,
        store,
        workerId: 'controller-1',
      }).publishPending(new AbortController().signal, 1)

      expect(created).toBe(0)
      expect(results).toEqual([{ _tag: 'Err', error: 'harlan-zw/example: GitHub timed out.' }])
    }
    finally {
      store.close()
    }
  })

  it('adopts the issue an ambiguous create already filed', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      store.stageCandidateIssues({
        commands: candidateIssueCommands(store.listCandidates(routine.routineId), routine),
        at: now().toISOString(),
      })
      let ghost: { number: number, url: string } | null = null
      let created = 0
      const ambiguous = {
        findOpenIssueByFingerprint: () => Promise.resolve(ok(ghost)),
        createIssue: async () => {
          created += 1
          ghost = { number: 7, url: 'https://github.com/harlan-zw/example/issues/7' }
          return { _tag: 'Err' as const, error: { repository: 'harlan-zw/example', message: 'The request timed out.' } }
        },
        createComment: async () => ok({ id: 1 }),
      }
      const controller = createCandidateIssueController({ github: ambiguous, now, store, workerId: 'controller-1' })

      await controller.publishPending(new AbortController().signal)
      const results = await controller.publishPending(new AbortController().signal)

      expect(created).toBe(1)
      expect(results).toEqual([{ _tag: 'Ok', value: { repository: 'harlan-zw/example', issueNumber: 7 } }])
    }
    finally {
      store.close()
    }
  })

  it('keeps a refused proposal claimable however many passes refuse it', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      store.stageCandidateIssues({
        commands: candidateIssueCommands(store.listCandidates(routine.routineId), routine),
        at: now().toISOString(),
      })
      const refusing = {
        findOpenIssueByFingerprint: () => Promise.resolve(ok(null)),
        createComment: async () => ok({ id: 1 }),
        createIssue: async () => ({ _tag: 'Err' as const, error: { repository: 'harlan-zw/example', message: 'GitHub returned 502.' } }),
      }
      const controller = createCandidateIssueController({ github: refusing, now, store, workerId: 'controller-1' })
      await controller.publishPending(new AbortController().signal)
      await controller.publishPending(new AbortController().signal)

      const claimed = store.claimNextCandidateIssue('controller-2', now().toISOString(), 60_000)

      expect(claimed?.title).toBe('pr-triage: This helper is never called.')
      expect(claimed?.reason).toBe('GitHub returned 502.')
    }
    finally {
      store.close()
    }
  })

  it('files nothing when the repository has writes turned off', async () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      store.stageCandidateIssues({
        commands: candidateIssueCommands(store.listCandidates(routine.routineId), routine),
        at: now().toISOString(),
      })
      store.setRepositoryWritesEnabled('harlan-zw/example', false)
      const calls: Array<{ title: string }> = []

      const results = await createCandidateIssueController({
        github: publisher(calls),
        now,
        store,
        workerId: 'controller-1',
      }).publishPending(new AbortController().signal)

      expect(results).toEqual([])
      expect(calls).toEqual([])
    }
    finally {
      store.close()
    }
  })

  it('keeps restart unsafe while an issue write holds its lease', () => {
    const store = openJournalStore(':memory:')
    try {
      seed(store)
      store.stageCandidateIssues({
        commands: candidateIssueCommands(store.listCandidates(routine.routineId), routine),
        at: now().toISOString(),
      })
      expect(store.claimNextCandidateIssue('controller-1', now().toISOString(), 60_000)).not.toBeNull()
      store.pauseAgents(now().toISOString())

      expect(store.getDashboardSnapshot(now().toISOString()).agentControl).toMatchObject({ safeToRestart: false })
    }
    finally {
      store.close()
    }
  })
})
