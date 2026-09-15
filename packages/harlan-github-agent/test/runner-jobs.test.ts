import { describe, expect, it } from 'vitest'
import { parseDesktopReport } from '../src/desktop-protocol.ts'
import { parseRunnerJobs } from '../src/runner-jobs.ts'

const job = { name: 'build', startedAt: 500 }
const runner = { name: 'runner-1', repository: 'harlan-zw/example', activity: 'Running', job }
const expected = { _tag: 'Available', jobs: [{ runner: 'runner-1', repository: 'harlan-zw/example', ...job }] }

describe('running GitHub Actions jobs', () => {
  it('reads desktop and Hogwild job names without counting starting runners', () => {
    expect(parseRunnerJobs({ updatedAt: 1000, runners: [runner, { activity: 'Starting' }] }, 1000)).toEqual(expected)
    expect(parseRunnerJobs({ updatedAt: 1000, runners: [{ ...runner, activity: { _tag: 'Running', job } }] }, 1000)).toEqual(expected)
  })
  it('distinguishes an idle host from missing, stale, and malformed telemetry', () => {
    expect(parseRunnerJobs({ updatedAt: 1000, runners: [] }, 1000)).toEqual({ _tag: 'Available', jobs: [] })
    for (const input of [null, {}, { updatedAt: 0, runners: [] }, { updatedAt: 40000, runners: [{ ...runner, repository: 'evil/../../host' }] }, { updatedAt: 40000, runners: [{ ...runner, job: null }] }])
      expect(parseRunnerJobs(input, 40000)).toEqual({ _tag: 'Unavailable' })
  })
  it('preserves job details through the desktop report and refuses unsafe repositories', () => {
    const report = { memoryGiB: 16, reservedGiB: 4, agents: 0, actions: 1 }
    expect(parseDesktopReport({ ...report, jobs: expected }).jobs).toEqual(expected)
    expect(parseDesktopReport({ ...report, jobs: { _tag: 'Available', jobs: [{ ...expected.jobs[0], repository: '../invalid' }] } }).jobs).toEqual({ _tag: 'Unavailable' })
  })
})
