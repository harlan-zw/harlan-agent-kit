import type { GitHubIssuePublisher } from './github.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { Candidate, RoutineName, RoutineReportCommand, RoutineRun } from './types.ts'
import { routineIssueLabel } from './candidate-issue-controller.ts'
import { err, ok } from './result.ts'

/** The issue every run of one Routine reports to. */
export function trackingIssueTitle(name: RoutineName, repository: string): string {
  return `${name}: run log for ${repository}`
}

function trackingIssueBodyText(name: string): string {
  return `Every run of the \`${name}\` routine reports here, including the runs that found nothing and the runs that were skipped.

Close a proposal's own issue to reject it. Closing this one stops the log, not the routine.

> The Harlan Agent Kit opened this issue automatically. It is not Harlan's own report.`
}

export function trackingIssueBody(name: RoutineName): string {
  return trackingIssueBodyText(name)
}

/** Stable identity for one Run report comment. */
export function routineRunMarker(runId: string): string {
  return `<!-- routine-run: ${runId} -->`
}

/** Recognises a run log even when another controller filed it. */
export function isRoutineTrackingIssue(input: {
  repository: string
  title: string
  body: string | null | undefined
  labels: readonly string[]
}): boolean {
  const prefix = 'routine:'
  return input.labels.some((label) => {
    if (!label.toLowerCase().startsWith(prefix))
      return false
    const routineName = label.slice(prefix.length)
    return routineName.length > 0
      && input.title.toLowerCase() === `${routineName}: run log for ${input.repository}`.toLowerCase()
      && input.body === trackingIssueBodyText(routineName)
  })
}

const MAXIMUM_REPORT_DETAIL_LENGTH = 20_000

/** What one finished run did, in the words the log records. */
export type RoutineRunReport
  = | { _tag: 'Completed', evidence: string, detail?: string }
    | { _tag: 'Skipped', reason: string }
    | { _tag: 'Failed', reason: string }

/**
 * Writes one run's line in the log.
 *
 * A run that found nothing says so. That is the whole point: without it a quiet
 * morning and a broken scheduler read exactly the same, which is nothing at all.
 */
function candidateDetails(candidates: readonly Candidate[]): string {
  if (candidates.length === 0)
    return ''
  return `\n\n${candidates.map(candidate => `${candidate.claim}

**Target:** \`${candidate.target}\`

**Verify with:** \`${candidate.verification}\`

Estimated to change ${candidate.estimatedChangedFiles} ${candidate.estimatedChangedFiles === 1 ? 'file' : 'files'}.`).join('\n\n---\n\n')}`
}

export function routineReportBody(run: Pick<RoutineRun, 'scheduledFor'>, report: RoutineRunReport, candidates: readonly Candidate[] = []): string {
  const headline = report._tag === 'Completed'
    ? report.evidence
    : report._tag === 'Skipped'
      ? `Skipped. ${report.reason}`
      : `Failed. ${report.reason}`
  // GitHub caps a comment at 65536 characters, and the Candidates follow.
  const detail = report._tag === 'Completed' && report.detail !== undefined && report.detail !== ''
    ? `\n\n${report.detail.slice(0, MAXIMUM_REPORT_DETAIL_LENGTH)}`
    : ''
  return `**${run.scheduledFor}** — ${headline}${detail}${candidateDetails(candidates)}`
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
    body: `${routineRunMarker(input.run.id)}\n${routineReportBody(input.run, input.report)}`,
  }
}

export interface RoutineReportControllerOptions {
  github: Pick<GitHubIssuePublisher, 'createComment' | 'createIssue' | 'findIssueCommentByMarker' | 'findRoutineTrackingIssue'>
  leaseMilliseconds?: number
  now: () => Date
  store: Pick<JournalStore, 'claimNextRoutineReport' | 'completeRoutineReport' | 'failRoutineReport' | 'recordRoutineReportReceipt'>
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
      const attemptedCommandIds: string[] = []
      for (let written = 0; written < limit; written += 1) {
        if (signal.aborted)
          return results
        const command = options.store.claimNextRoutineReport(
          options.workerId,
          options.now().toISOString(),
          leaseMilliseconds,
          attemptedCommandIds,
        )
        if (command === null)
          return results
        attemptedCommandIds.push(command.id)

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
          const existing = await options.github.findRoutineTrackingIssue({
            repository: command.repositoryMapping,
            routineName: command.routineName,
          }, signal)
          if (existing._tag === 'Err') {
            fail(existing.error.message)
            continue
          }
          if (existing.value !== null) {
            issueNumber = existing.value.number
          }
          else {
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
        }

        const issueConfirmed = options.store.recordRoutineReportReceipt({
          commandId: command.id,
          workerId: command.workerId,
          fence: command.fence,
          at: options.now().toISOString(),
          sink: 'tracking_issue',
        })
        if (!issueConfirmed) {
          results.push(err(`${command.repository}: The Routine report lease changed after GitHub confirmed the tracking Issue.`))
          continue
        }

        const marker = routineRunMarker(command.runId)
        const existingComment = await options.github.findIssueCommentByMarker({
          repository: command.repositoryMapping,
          issueNumber,
          marker,
        }, signal)
        if (existingComment._tag === 'Err') {
          fail(existingComment.error.message)
          continue
        }
        if (existingComment.value !== null) {
          const commentConfirmed = options.store.recordRoutineReportReceipt({
            commandId: command.id,
            workerId: command.workerId,
            fence: command.fence,
            at: options.now().toISOString(),
            sink: 'run_comment',
          })
          if (!commentConfirmed) {
            results.push(err(`${command.repository}: The Routine report lease changed after GitHub confirmed the run comment.`))
            continue
          }
          options.store.completeRoutineReport({
            commandId: command.id,
            workerId: command.workerId,
            fence: command.fence,
            at: options.now().toISOString(),
            commentId: existingComment.value.id,
            trackingIssueNumber: issueNumber,
          })
          results.push(ok({ repository: command.repository, issueNumber }))
          continue
        }

        const commented = await options.github.createComment({
          repository: command.repositoryMapping,
          issueNumber,
          body: `${command.body}${candidateDetails(command.candidates)}`,
        }, signal)
        if (commented._tag === 'Err') {
          fail(commented.error.message)
          continue
        }

        const commentConfirmed = options.store.recordRoutineReportReceipt({
          commandId: command.id,
          workerId: command.workerId,
          fence: command.fence,
          at: options.now().toISOString(),
          sink: 'run_comment',
        })
        if (!commentConfirmed) {
          results.push(err(`${command.repository}: The Routine report lease changed after GitHub accepted the run comment.`))
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
