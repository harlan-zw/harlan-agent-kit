import type { GitHubReadError, GitHubSource, RoutineSpecSource } from '../src/github.ts'
import type { Result } from '../src/result.ts'
import { describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { planRoutineRuns, syncRepositoryRoutines } from '../src/routine-controller.ts'
import { openJournalStore } from '../src/store.ts'
import { repositoryMapping } from './fixtures.ts'

const specText = `
version: 1
routines:
  - name: sentry-checkin
    on:
      schedule:
        - cron: "0 7 * * *"
    timezone: UTC
`

function githubReturning(source: Result<RoutineSpecSource, GitHubReadError>): Pick<GitHubSource, 'readRoutineSpec'> {
  return { readRoutineSpec: async () => source }
}

const at = (iso = '2026-08-27T08:00:00.000Z') => () => new Date(iso)

describe('syncing one repository Routine spec', () => {
  it('stores what the default branch declares, with its commit', async () => {
    const store = openJournalStore(':memory:')
    try {
      const outcome = await syncRepositoryRoutines(repositoryMapping(), {
        github: githubReturning(ok({ _tag: 'Present', specSha: 'abc123', text: specText })),
        now: at(),
        store,
      })

      expect(outcome).toMatchObject({ _tag: 'Synced' })
      expect(store.listRoutines()).toMatchObject([{ name: 'sentry-checkin', specSha: 'abc123', crons: ['0 7 * * *'] }])
    }
    finally {
      store.close()
    }
  })

  it('stores nothing when the repository declares no spec, which is normal', async () => {
    const store = openJournalStore(':memory:')
    try {
      const outcome = await syncRepositoryRoutines(repositoryMapping(), {
        github: githubReturning(ok({ _tag: 'Absent', specSha: 'abc123' })),
        now: at(),
        store,
      })

      expect(outcome).toEqual({ _tag: 'Absent', retired: [] })
      expect(store.listRoutines()).toEqual([])
    }
    finally {
      store.close()
    }
  })

  it('names the routines it retires when a declared spec disappears', async () => {
    const store = openJournalStore(':memory:')
    try {
      await syncRepositoryRoutines(repositoryMapping(), {
        github: githubReturning(ok({
          _tag: 'Present',
          specSha: 'abc123',
          text: 'version: 1\nroutines:\n  - name: sentry-checkin\n    on:\n      schedule:\n        - cron: "0 5 * * *"\n    timezone: Australia/Sydney\n    mode: propose\n    enabled: true\n',
        })),
        now: at(),
        store,
      })
      expect(store.listRoutines().map(routine => routine.name)).toEqual(['sentry-checkin'])

      const outcome = await syncRepositoryRoutines(repositoryMapping(), {
        github: githubReturning(ok({ _tag: 'Absent', specSha: 'def456' })),
        now: at(),
        store,
      })

      expect(outcome).toEqual({ _tag: 'Absent', retired: ['sentry-checkin'] })
      expect(store.listRoutines()).toEqual([])
    }
    finally {
      store.close()
    }
  })

  it('refuses a spec that reaches past its authority, and runs none of it', async () => {
    const store = openJournalStore(':memory:')
    try {
      const outcome = await syncRepositoryRoutines(repositoryMapping(), {
        github: githubReturning(ok({
          _tag: 'Present',
          specSha: 'abc123',
          text: 'version: 1\nroutines:\n  - name: pr-triage\n    command: rm -rf /\n    on:\n      schedule:\n        - cron: "0 9 * * *"\n',
        })),
        now: at(),
        store,
      })

      expect(outcome).toMatchObject({ _tag: 'Refused' })
      expect(store.listRoutines()).toEqual([])
    }
    finally {
      store.close()
    }
  })

  it('refuses a spec whose cron can never come due', async () => {
    const store = openJournalStore(':memory:')
    try {
      const outcome = await syncRepositoryRoutines(repositoryMapping(), {
        github: githubReturning(ok({
          _tag: 'Present',
          specSha: 'abc123',
          text: 'version: 1\nroutines:\n  - name: pr-triage\n    on:\n      schedule:\n        - cron: "0 99 * * *"\n',
        })),
        now: at(),
        store,
      })

      expect(outcome).toMatchObject({ _tag: 'Refused', reason: 'pr-triage: Write a hour from 0 to 23.' })
      expect(store.listRoutines()).toEqual([])
    }
    finally {
      store.close()
    }
  })

  it('keeps stored Routines when GitHub cannot answer, because the spec may be fine', async () => {
    const store = openJournalStore(':memory:')
    try {
      await syncRepositoryRoutines(repositoryMapping(), {
        github: githubReturning(ok({ _tag: 'Present', specSha: 'abc123', text: specText })),
        now: at(),
        store,
      })
      const outcome = await syncRepositoryRoutines(repositoryMapping(), {
        github: { readRoutineSpec: async () => ({ _tag: 'Err', error: { repository: 'harlan-zw/example', message: 'GitHub is unavailable.' } }) },
        now: at('2026-08-27T09:00:00.000Z'),
        store,
      })

      expect(outcome).toMatchObject({ _tag: 'Unread' })
      expect(store.listRoutines()).toHaveLength(1)
    }
    finally {
      store.close()
    }
  })

  it('requests saved Candidates when a report Routine changes to propose', async () => {
    const store = openJournalStore(':memory:')
    try {
      store.syncRepositories([repositoryMapping()], '2026-08-27T00:00:00.000Z')
      store.setRepositoryWritesEnabled('harlan-zw/example', true)
      await syncRepositoryRoutines(repositoryMapping(), {
        github: githubReturning(ok({ _tag: 'Present', specSha: 'report-sha', text: specText })),
        now: at('2026-08-27T00:00:00.000Z'),
        store,
      })
      const run = store.openRoutineRun({
        routineId: 'harlan-zw/example:sentry-checkin',
        scheduledFor: '2026-08-27T07:00:00.000Z',
        specSha: 'report-sha',
        at: '2026-08-27T07:00:05.000Z',
      })
      if (run === null)
        throw new Error('Expected a Routine run.')
      const [candidate] = store.recordCandidates({
        routineId: run.routineId,
        runId: run.id,
        candidates: [{
          fingerprint: 'src/cache.ts#stale-fallback',
          title: 'Fixture title',
          target: 'src/cache.ts',
          claim: 'The stale fallback differs between cache readers.',
          verification: 'pnpm test',
          estimatedChangedFiles: 2,
        }],
        at: '2026-08-27T07:05:00.000Z',
      })
      if (candidate === undefined)
        throw new Error('Expected a saved Candidate.')

      await syncRepositoryRoutines(repositoryMapping(), {
        github: githubReturning(ok({
          _tag: 'Present',
          specSha: 'propose-sha',
          text: specText.replace('timezone: UTC', 'timezone: UTC\n    mode: propose'),
        })),
        now: at('2026-08-27T08:00:00.000Z'),
        store,
      })

      expect(store.claimNextCandidateIssue('controller-1', '2026-08-27T08:01:00.000Z', 60_000))
        .toMatchObject({ candidateId: candidate.id })
    }
    finally {
      store.close()
    }
  })
})

describe('planning the Routine runs that are due', () => {
  async function seed(store: ReturnType<typeof openJournalStore>, text = specText): Promise<void> {
    await syncRepositoryRoutines(repositoryMapping(), {
      github: githubReturning(ok({ _tag: 'Present', specSha: 'abc123', text })),
      now: at('2026-08-26T00:00:00.000Z'),
      store,
    })
  }

  it('opens a run for a Routine whose instant has passed', async () => {
    const store = openJournalStore(':memory:')
    try {
      await seed(store)
      const plan = planRoutineRuns({ now: at('2026-08-27T07:30:00.000Z'), store })

      expect(plan.opened).toMatchObject([{ name: 'sentry-checkin', scheduledFor: '2026-08-27T07:00:00.000Z' }])
      expect(plan.skipped).toEqual([])
    }
    finally {
      store.close()
    }
  })

  it('opens nothing on a second pass, so one instant runs once', async () => {
    const store = openJournalStore(':memory:')
    try {
      await seed(store)
      planRoutineRuns({ now: at('2026-08-27T07:30:00.000Z'), store })
      const second = planRoutineRuns({ now: at('2026-08-27T07:31:00.000Z'), store })

      expect(second.opened).toEqual([])
    }
    finally {
      store.close()
    }
  })

  it('records a skip for an instant outside the catch-up window', async () => {
    const store = openJournalStore(':memory:')
    try {
      await seed(store)
      planRoutineRuns({ now: at('2026-08-27T07:30:00.000Z'), store })
      const later = planRoutineRuns({ now: at('2026-08-29T06:00:00.000Z'), store })

      expect(later.opened).toEqual([])
      expect(later.skipped).toMatchObject([{ scheduledFor: '2026-08-28T07:00:00.000Z' }])
    }
    finally {
      store.close()
    }
  })

  it('opens one run for a Routine that lists two schedules on the same morning', async () => {
    const store = openJournalStore(':memory:')
    try {
      await seed(store, `
version: 1
routines:
  - name: pr-triage
    timezone: UTC
    on:
      schedule:
        - cron: "0 7 * * *"
        - cron: "0 7 * * 4"
`)
      const plan = planRoutineRuns({ now: at('2026-08-27T07:30:00.000Z'), store })

      expect(plan.opened).toHaveLength(1)
      expect(plan.opened[0]?.scheduledFor).toBe('2026-08-27T07:00:00.000Z')
    }
    finally {
      store.close()
    }
  })

  it('opens nothing for a disabled Routine, and no catch-up when it returns', async () => {
    const store = openJournalStore(':memory:')
    try {
      await seed(store, `
version: 1
routines:
  - name: pr-triage
    enabled: false
    timezone: UTC
    on:
      schedule:
        - cron: "0 7 * * *"
`)

      expect(planRoutineRuns({ now: at('2026-08-27T07:30:00.000Z'), store }).opened).toEqual([])
    }
    finally {
      store.close()
    }
  })
})

const sydneySpec = 'version: 1\nroutines:\n  - name: sentry-checkin\n    on:\n      schedule:\n        - cron: "0 5 * * *"\n    timezone: Australia/Sydney\n    mode: propose\n    enabled: true\n'

describe('moving a Routine spec', () => {
  it('keeps the last run across retire and revive, so a missed instant is still reported', async () => {
    const store = openJournalStore(':memory:')
    try {
      await syncRepositoryRoutines(repositoryMapping(), {
        github: githubReturning(ok({ _tag: 'Present', specSha: 'abc123', text: sydneySpec })),
        now: at('2026-08-30T18:00:00.000Z'),
        store,
      })
      const onTime = planRoutineRuns({ now: at('2026-08-30T19:00:30.000Z'), store })
      expect(onTime.opened.map(run => run.scheduledFor)).toEqual(['2026-08-30T19:00:00.000Z'])

      // The next morning passes with no pass planning it. That afternoon the
      // spec file moves, so one sync retires the Routine and the next revives it.
      await syncRepositoryRoutines(repositoryMapping(), {
        github: githubReturning(ok({ _tag: 'Absent', specSha: 'def456' })),
        now: at('2026-09-01T04:21:49.000Z'),
        store,
      })
      await syncRepositoryRoutines(repositoryMapping(), {
        github: githubReturning(ok({ _tag: 'Present', specSha: 'def456', text: sydneySpec })),
        now: at('2026-09-01T04:21:50.000Z'),
        store,
      })

      const afterMove = planRoutineRuns({ now: at('2026-09-01T04:25:00.000Z'), store })
      expect(afterMove.opened).toEqual([])
      expect(afterMove.skipped.map(run => run.scheduledFor)).toEqual(['2026-08-31T19:00:00.000Z'])
    }
    finally {
      store.close()
    }
  })
})
