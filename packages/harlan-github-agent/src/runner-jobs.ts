export interface RunnerJob {
  runner: string
  repository: string
  name: string
  startedAt: number
}

export type RunnerJobs = { _tag: 'Available', jobs: RunnerJob[] } | { _tag: 'Unavailable' }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read only named running jobs. Missing or stale telemetry cannot prove an idle host. */
export function parseRunnerJobs(value: unknown, now: number): RunnerJobs {
  if (!record(value) || !Number.isSafeInteger(value.updatedAt)
    || Number(value.updatedAt) > now + 30_000 || now - Number(value.updatedAt) > 30_000
    || !Array.isArray(value.runners)) {
    return { _tag: 'Unavailable' }
  }
  const jobs: RunnerJob[] = []
  for (const runner of value.runners) {
    if (!record(runner))
      return { _tag: 'Unavailable' }
    // The private Hogwild feed wraps activity. Desktop status uses the raw publisher format.
    const activity = record(runner.activity) ? runner.activity._tag : runner.activity
    if (activity === 'Starting')
      continue
    const job = record(runner.activity) ? runner.activity.job : runner.job
    if (activity !== 'Running' || !record(job) || typeof runner.name !== 'string'
      || typeof runner.repository !== 'string' || !/^[a-z0-9][a-z0-9-]*\/[\w.-]+$/i.test(runner.repository)
      || typeof job.name !== 'string' || job.name.length === 0 || !Number.isSafeInteger(job.startedAt)
      || Number(job.startedAt) < 0) {
      return { _tag: 'Unavailable' }
    }
    jobs.push({ runner: runner.name, repository: runner.repository, name: job.name, startedAt: Number(job.startedAt) })
  }
  return { _tag: 'Available', jobs }
}
