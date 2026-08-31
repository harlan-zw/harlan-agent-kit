import type { GitHubAgentSource } from './github-agent-source.ts'
import type { JournalStore } from './store.ts'
import { publishClaimedReviewStatus } from './review-status-controller.ts'

export interface ReviewStatusScheduler {
  runNow: () => Promise<void>
  start: () => void
  stop: () => Promise<void>
}

export interface ReviewStatusSchedulerOptions {
  github: Pick<GitHubAgentSource, 'getPullRequestReviewSnapshot' | 'stampAgentLabel' | 'upsertReviewStatus'>
  intervalMilliseconds: number
  leaseMilliseconds: number
  now: () => Date
  onError: (error: unknown) => void
  onFailure: (repository: string, pullRequestNumber: number, reason: string) => void
  store: Pick<JournalStore, 'claimNextTerminalReviewStatus' | 'completeReviewStatus' | 'deferReviewStatus' | 'recordReviewStatusReceipt'>
  workerId: string
}

/** Resumes terminal comment Publication without starting another Agent Task. */
export function createReviewStatusScheduler(options: ReviewStatusSchedulerOptions): ReviewStatusScheduler {
  let stopped = true
  let timer: NodeJS.Timeout | undefined
  let controller: AbortController | undefined
  let active: Promise<void> = Promise.resolve()

  async function execute(): Promise<void> {
    const command = options.store.claimNextTerminalReviewStatus(
      options.workerId,
      options.now().toISOString(),
      options.leaseMilliseconds,
    )
    if (command === null)
      return

    controller = new AbortController()
    const published = await publishClaimedReviewStatus(options, command, true, controller.signal)
    if (published._tag === 'Err' && !controller.signal.aborted)
      options.onFailure(command.repository, command.pullRequestNumber, published.error)
  }

  function runNow(): Promise<void> {
    active = active.then(execute).catch(options.onError)
    return active
  }

  function schedule(): void {
    if (stopped)
      return
    timer = setTimeout(() => void runNow().finally(schedule), options.intervalMilliseconds)
    timer.unref()
  }

  function start(): void {
    if (!stopped)
      return
    stopped = false
    void runNow().finally(schedule)
  }

  async function stop(): Promise<void> {
    stopped = true
    if (timer !== undefined)
      clearTimeout(timer)
    controller?.abort()
    await active
  }

  return { runNow, start, stop }
}
