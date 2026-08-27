import { describe, expect, it } from 'vitest'
import { parseConfigText } from '../src/config.ts'
import { dashboardSnapshotForTriggers, recordRoutineOnlyRepositoryHealth } from '../src/service.ts'
import { dashboardSnapshot } from './fixtures.ts'

const base = `
github:
  app_id: 12345
  private_key_path: /home/harlan/.config/harlan-github-agent/app.pem
  allowed_owners: [harlan-zw]
server:
  host: 127.0.0.1
  port: 3210
  allowed_origin: https://harlan-github-agent.localhost
storage:
  path: /home/harlan/.local/share/harlan-github-agent/state.sqlite
mutations_enabled: false
max_open_pull_requests: 8
poll_interval_seconds: 60
issue_cutoff: 2026-07-14
external_repositories: []
repositories: []
`

function parse(extra = ''): ReturnType<typeof parseConfigText> {
  return parseConfigText(`${base}${extra}`)
}

describe('which triggers one machine answers', () => {
  const routineSnapshot = dashboardSnapshot({
    routines: [{
      id: 'harlan-zw/example:sentry-checkin',
      repository: 'harlan-zw/example',
      name: 'sentry-checkin',
      crons: ['0 7 * * *'],
      timeZone: 'Australia/Melbourne',
      mode: 'report',
      enabled: true,
      specSha: 'abc123',
      lastRunAt: '2026-08-28T21:00:00.000Z',
      trackingIssueNumber: 42,
      updatedAt: '2026-08-28T21:01:00.000Z',
    }],
    routineRuns: [{
      id: 'routine-run-1',
      routineId: 'harlan-zw/example:sentry-checkin',
      repository: 'harlan-zw/example',
      name: 'sentry-checkin',
      scheduledFor: '2026-08-28T21:00:00.000Z',
      specSha: 'abc123',
      state: { _tag: 'Completed', evidence: 'No open Sentry issues.' },
      fence: 1,
      attempts: 1,
      createdAt: '2026-08-28T21:00:00.000Z',
      updatedAt: '2026-08-28T21:01:00.000Z',
    }],
  })

  it('answers every trigger when the file says nothing', () => {
    const parsed = parse()

    expect(parsed._tag).toBe('Ok')
    expect(parsed._tag === 'Ok' ? parsed.value.triggers : []).toEqual(['github', 'routine'])
  })

  it('answers routines only, which is what the second machine runs', () => {
    const parsed = parse('triggers: [routine]\n')

    expect(parsed._tag === 'Ok' ? parsed.value.triggers : []).toEqual(['routine'])
  })

  it('answers GitHub only, which is what the desktop keeps', () => {
    const parsed = parse('triggers: [github]\n')

    expect(parsed._tag === 'Ok' ? parsed.value.triggers : []).toEqual(['github'])
  })

  it('hides stale Routine history from a GitHub-only dashboard', () => {
    const visible = dashboardSnapshotForTriggers(routineSnapshot, ['github'])

    expect(visible.routines).toEqual([])
    expect(visible.routineRuns).toEqual([])
  })

  it('keeps Routine history on a Routine dashboard', () => {
    const visible = dashboardSnapshotForTriggers(routineSnapshot, ['routine'])

    expect(visible.routines.map(routine => routine.id)).toEqual(['harlan-zw/example:sentry-checkin'])
    expect(visible.routineRuns.map(run => run.id)).toEqual(['routine-run-1'])
  })

  it('refuses an empty list, because a machine that answers nothing is a mistake', () => {
    const parsed = parse('triggers: []\n')

    expect(parsed).toEqual({ _tag: 'Err', error: [{ path: '$.triggers', message: 'Expected at least one trigger.' }] })
  })

  it('refuses a trigger the service does not have', () => {
    const parsed = parse('triggers: [webhook]\n')

    expect(parsed).toEqual({ _tag: 'Err', error: [{ path: '$.triggers', message: 'Expected github or routine.' }] })
  })

  it('refuses a repeated trigger', () => {
    const parsed = parse('triggers: [routine, routine]\n')

    expect(parsed).toEqual({ _tag: 'Err', error: [{ path: '$.triggers', message: 'List every trigger once.' }] })
  })

  it('becomes ready after a Routine-only repository sync', () => {
    const observations: string[] = []

    recordRoutineOnlyRepositoryHealth({
      at: '2026-08-28T01:00:00.000Z',
      outcome: { _tag: 'Synced', routines: [] },
      repository: 'harlan-zw/example',
      store: {
        recordPollFailure: () => observations.push('failure'),
        recordPollSuccess: repository => observations.push(`success:${repository}`),
      },
    })

    expect(observations).toEqual(['success:harlan-zw/example'])
  })

  it('reports an unreadable Routine spec as repository failure', () => {
    const observations: string[] = []

    recordRoutineOnlyRepositoryHealth({
      at: '2026-08-28T01:00:00.000Z',
      outcome: { _tag: 'Unread', reason: 'GitHub timed out.' },
      repository: 'harlan-zw/example',
      store: {
        recordPollFailure: (repository, _at, reason) => observations.push(`failure:${repository}:${reason}`),
        recordPollSuccess: () => observations.push('success'),
      },
    })

    expect(observations).toEqual(['failure:harlan-zw/example:The Routine spec could not be read. GitHub timed out.'])
  })
})
