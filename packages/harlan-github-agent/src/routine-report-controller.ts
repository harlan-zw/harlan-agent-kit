import type { GitHubIssuePublisher } from './github.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { RoutineName, RoutineReportCommand, RoutineRun } from './types.ts'
import { routineIssueLabel } from './candidate-issue-controller.ts'
import { err, ok } from './result.ts'

/** The issue every run of one Routine reports to. */
export function trackingIssueTitle(name: RoutineName, repository: string): string {
  return `${name}: run log for ${repository}`
}

export function trackingIssueBody(name: RoutineName): string {
  return `Every run of the \`${name}\` routine reports here, including the runs that found nothing and the runs that were skipped.

Close a proposal's own issue to reject it. Closing this one stops the log, not the routine.

> The Harlan Agent Kit opened this issue automatically. It is not Harlan's own report.`
}

/** What one finished run did, in the words the log records. */
export type RoutineRunReport
  = | { _tag: 'Completed', evidence: string }
    | { _tag: 'Skipped', reason: string }
    | { _tag: 'Failed', reason: string }

/**
 * Writes one run's line in the log.
 *
 * A run that found nothing says so. That is the whole point: without it a quiet
 * morning and a broken scheduler read exactly the same, which is nothing at all.
 */
export function routineReportBody(run: Pick<RoutineRun, 'scheduledFor'>, report: RoutineRunReport): string {
  const headline = report._tag === 'Completed'
    ? report.evidence
    : report._tag === 'Skipped'
      ? `Skipped. ${report.reason}`
      : `Failed. ${report.reason}`
  return `**${run.scheduledFor}** — ${headline}`
}

/** One report request for one finished run. */
export function routineReportCommand(input: {
  repository: string
  routineId: string
  routineName: RoutineName
  run: Pick<RoutineRun, 'id' | 'scheduledFor'>
  report: RoutineRunReport
}): RoutineReportCommand {
  return {
    id: `${input.run.id}:report`,
    routineId: input.routineId,
    runId: input.run.id,
    repository: input.repository,
    routineName: input.routineName,
    body: routineReportBody(input.run, input.report),
  }
}

export interface RoutineReportControllerOptions {
  github: GitHubIssuePublisher
  leaseMilliseconds?: number
  now: () => Date
  store: Pick<JournalStore, 'claimNextRoutineReport' | 'completeRoutineReport' | 'failRoutineReport'>
  workerId: string
}

export interface RoutineReportController {
  publishPending: (signal: AbortSignal, limit?: number) => Promise<Array<Result<{ repository: string, issueNumber: number }, string>>>
}

/**
 * Writes pending run log entries, opening the tracking issue the first time.
 *
 * The issue number is stored only once the comment lands. A run that opened the
 * issue and then failed to comment would otherwise leave the Routine pointing
 * at an empty issue, and the retry would comment on it while the log claims the
 * run never reported.
 */
export function createRoutineReportController(options: RoutineReportControllerOptions): RoutineReportController {
  const leaseMilliseconds = options.leaseMilliseconds ?? 60_000

  return {
    publishPending: async (signal, limit = 3) => {
      const results: Array<Result<{ repository: string, issueNumber: number }, string>> = []
      for (let written = 0; written < limit; written += 1) {
        if (signal.aborted)
          return results
        const command = options.store.claimNextRoutineReport(
          options.workerId,
          options.now().toISOString(),
          leaseMilliseconds,
        )
        if (command === null)
          return results

        const fail = (message: string): void => {
          if (signal.aborted)
            return
          options.store.failRoutineReport({
            commandId: command.id,
            workerId: command.workerId,
            fence: command.fence,
            at: options.now().toISOString(),
            reason: message,
          })
          results.push(err(`${command.repository}: ${message}`))
        }

        let issueNumber = command.trackingIssueNumber
        if (issueNumber === null) {
          const created = await options.github.createIssue({
            repository: command.repositoryMapping,
            title: trackingIssueTitle(command.routineName, command.repository),
            body: trackingIssueBody(command.routineName),
            labels: [routineIssueLabel(command.routineName)],
          }, signal)
          if (created._tag === 'Err') {
            fail(created.error.message)
            continue
          }
          issueNumber = created.value.number
        }

        const commented = await options.github.createComment({
          repository: command.repositoryMapping,
          issueNumber,
          body: command.body,
        }, signal)
        if (commented._tag === 'Err') {
          fail(commented.error.message)
          continue
        }

        options.store.completeRoutineReport({
          commandId: command.id,
          workerId: command.workerId,
          fence: command.fence,
          at: options.now().toISOString(),
          commentId: commented.value.id,
          trackingIssueNumber: issueNumber,
        })
        results.push(ok({ repository: command.repository, issueNumber }))
      }
      return results
    },
  }
}
