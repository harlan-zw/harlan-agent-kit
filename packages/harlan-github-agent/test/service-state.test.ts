import { existsSync, mkdtempSync, rmSync, symlinkSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { routineReportCommand } from '../src/routine-report-controller.ts'
import { combineServiceState } from '../src/service-state.ts'
import { openJournalStore } from '../src/store.ts'
import { issueItem, repositoryMapping } from './fixtures.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  temporaryDirectories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
})

function paths() {
  const directory = mkdtempSync(join(tmpdir(), 'harlan-github-agent-state-'))
  temporaryDirectories.push(directory)
  return {
    github: join(directory, 'github.sqlite'),
    routine: join(directory, 'routine.sqlite'),
    output: join(directory, 'combined.sqlite'),
  }
}

function seedGitHubState(path: string, paused = true): void {
  const store = openJournalStore(path)
  try {
    store.syncRepositories([repositoryMapping()], '2026-08-28T00:00:00.000Z')
    store.recordObservation({
      externalId: 'github-issue-12',
      observedAt: '2026-08-28T00:01:00.000Z',
      source: 'poll',
      subject: issueItem(),
    })
    store.syncRoutines({
      repository: 'harlan-zw/example',
      specSha: 'old',
      entries: [{ name: 'sentry-checkin', crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'report', enabled: true }],
      at: '2026-08-26T00:00:00.000Z',
    })
    store.skipRoutineRun({
      routineId: 'harlan-zw/example:sentry-checkin',
      scheduledFor: '2026-08-26T07:00:00.000Z',
      specSha: 'old',
      reason: 'The old machine skipped this run.',
      at: '2026-08-26T07:00:00.000Z',
    })
    if (paused)
      store.pauseAgents('2026-08-28T00:02:00.000Z')
  }
  finally {
    store.close()
  }
}

function seedRoutineState(path: string): void {
  const store = openJournalStore(path)
  try {
    store.syncRepositories([repositoryMapping({ checkout: '/home/harlan/sites/example' })], '2026-08-28T00:00:00.000Z')
    store.syncRoutines({
      repository: 'harlan-zw/example',
      specSha: 'new',
      entries: [{ name: 'pr-triage', crons: ['0 8 * * *'], timeZone: 'UTC', mode: 'propose', enabled: true }],
      at: '2026-08-28T00:01:00.000Z',
    })
    const run = store.openRoutineRun({
      routineId: 'harlan-zw/example:pr-triage',
      scheduledFor: '2026-08-28T08:00:00.000Z',
      specSha: 'new',
      at: '2026-08-28T08:00:00.000Z',
    })
    if (run === null)
      throw new Error('Expected a Routine run.')
    store.recordCandidates({
      routineId: run.routineId,
      runId: run.id,
      candidates: [{
        fingerprint: 'src/store.ts#openRoutineRun',
        title: 'Fixture title',
        target: 'src/store.ts',
        claim: 'One Routine result belongs on Hogwild.',
        verification: 'pnpm test',
        estimatedChangedFiles: 1,
      }],
      at: '2026-08-28T08:05:00.000Z',
    })
    store.stageRoutineReport({
      command: routineReportCommand({
        repository: 'harlan-zw/example',
        routineId: run.routineId,
        routineName: 'pr-triage',
        run: { id: run.id, scheduledFor: run.scheduledFor },
        report: { _tag: 'Completed', evidence: 'One Candidate found.' },
      }),
      at: '2026-08-28T08:05:30.000Z',
    })
    store.pauseAgents('2026-08-28T08:06:00.000Z')
  }
  finally {
    store.close()
  }
}

describe('combining service state', () => {
  it('keeps GitHub work and replaces Routine work with Hogwild state', async () => {
    const path = paths()
    seedGitHubState(path.github)
    seedRoutineState(path.routine)

    const result = await combineServiceState({ githubPath: path.github, routinePath: path.routine, outputPath: path.output })

    expect(result).toEqual({
      _tag: 'Ok',
      value: { routines: 1, routineRuns: 1, candidates: 1, routineReports: 1, routinePublications: 0, incidents: 0 },
    })
    const combined = openJournalStore(path.output)
    try {
      const dashboard = combined.getDashboardSnapshot('2026-08-28T08:07:00.000Z')
      expect(dashboard.items).toEqual([expect.objectContaining({ number: 12, title: 'Broken thing' })])
      expect(dashboard.routines).toEqual([expect.objectContaining({ name: 'pr-triage', specSha: 'new' })])
      expect(dashboard.routineRuns).toEqual([expect.objectContaining({
        id: 'harlan-zw/example:pr-triage:2026-08-28T08:00:00.000Z',
        reportState: 'Pending',
      })])
      expect(combined.listCandidates('harlan-zw/example:pr-triage')).toEqual([
        expect.objectContaining({ claim: 'One Routine result belongs on Hogwild.' }),
      ])
      expect(combined.getAgentControl()).toEqual({ _tag: 'Paused', pausedAt: '2026-08-28T00:02:00.000Z' })
    }
    finally {
      combined.close()
    }
  })

  it('refuses a source that is still running and leaves no output', async () => {
    const path = paths()
    seedGitHubState(path.github, false)
    seedRoutineState(path.routine)

    const result = await combineServiceState({ githubPath: path.github, routinePath: path.routine, outputPath: path.output })

    expect(result).toEqual({ _tag: 'Err', error: { _tag: 'SourceRunning', source: 'GitHub' } })
    expect(existsSync(path.output)).toBe(false)
  })

  it('never replaces an existing output file', async () => {
    const path = paths()
    seedGitHubState(path.github)
    seedRoutineState(path.routine)
    seedGitHubState(path.output)

    const result = await combineServiceState({ githubPath: path.github, routinePath: path.routine, outputPath: path.output })

    expect(result).toEqual({ _tag: 'Err', error: { _tag: 'OutputExists', path: path.output } })
    const untouched = openJournalStore(path.output)
    try {
      expect(untouched.getDashboardSnapshot('2026-08-28T08:07:00.000Z').routines[0]?.name).toBe('sentry-checkin')
    }
    finally {
      untouched.close()
    }
  })

  it.each([
    ['GitHub', 'github'],
    ['Routine', 'routine'],
  ] as const)('attributes a corrupt %s source precisely', async (source, key) => {
    const path = paths()
    seedGitHubState(path.github)
    seedRoutineState(path.routine)
    truncateSync(path[key], 64)

    const result = await combineServiceState({ githubPath: path.github, routinePath: path.routine, outputPath: path.output })

    expect(result).toEqual({
      _tag: 'Err',
      error: expect.objectContaining({ _tag: 'SourceInvalid', source }),
    })
    expect(existsSync(path.output)).toBe(false)
  })

  it('attributes a failure while publishing the output precisely', async () => {
    const path = paths()
    seedGitHubState(path.github)
    seedRoutineState(path.routine)
    symlinkSync('missing.sqlite', path.output)

    const result = await combineServiceState({ githubPath: path.github, routinePath: path.routine, outputPath: path.output })

    expect(result).toEqual({
      _tag: 'Err',
      error: expect.objectContaining({ _tag: 'OutputPublicationFailed', path: path.output }),
    })
  })
})
