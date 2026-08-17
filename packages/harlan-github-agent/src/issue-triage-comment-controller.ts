import type { GitHubAgentSource, PublishedReviewStatus } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { ClaimedIssueTriageTask } from './types.ts'
import { err, ok } from './result.ts'

export interface IssueTriageCommentController {
  publish: (task: ClaimedIssueTriageTask, body: string, signal: AbortSignal) => Promise<Result<PublishedReviewStatus, string>>
}

export interface IssueTriageCommentControllerOptions {
  github: Pick<GitHubAgentSource, 'getIssueTriageSnapshot' | 'upsertIssueTriageComment'>
  leaseMilliseconds: number
  now: () => Date
  store: Pick<JournalStore, 'claimIssueTriageComment' | 'completeIssueTriageComment' | 'deferIssueTriageComment' | 'stageIssueTriageComment'>
  workerId: string
}

export function createIssueTriageCommentController(options: IssueTriageCommentControllerOptions): IssueTriageCommentController {
  return {
    async publish(task, body, signal) {
      const at = options.now().toISOString()
      const staged = options.store.stageIssueTriageComment({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        revisionId: task.revisionId,
        expectedUpdatedAt: task.issue.updatedAt,
        body,
      })
      if (staged._tag === 'Rejected')
        return err(staged.reason)
      const command = options.store.claimIssueTriageComment(staged.commandId, options.workerId, at, options.leaseMilliseconds)
      if (command === null)
        return err('The issue triage comment could not be queued.')

      const current = await options.github.getIssueTriageSnapshot(command.repositoryMapping, command.issueNumber, signal)
      if (current._tag === 'Err') {
        options.store.deferIssueTriageComment({
          commandId: command.id,
          workerId: command.workerId,
          fence: command.fence,
          at: options.now().toISOString(),
          reason: current.error,
        })
        return current
      }
      if (current.value.state !== 'open' || current.value.updatedAt !== command.expectedUpdatedAt) {
        const reason = 'The issue changed before the triage comment was posted.'
        options.store.deferIssueTriageComment({
          commandId: command.id,
          workerId: command.workerId,
          fence: command.fence,
          at: options.now().toISOString(),
          reason,
        })
        return err(reason)
      }

      const published = await options.github.upsertIssueTriageComment(
        command.repositoryMapping,
        command.issueNumber,
        command.commentId,
        command.body,
        signal,
      )
      if (published._tag === 'Err') {
        options.store.deferIssueTriageComment({
          commandId: command.id,
          workerId: command.workerId,
          fence: command.fence,
          at: options.now().toISOString(),
          reason: published.error,
        })
        return published
      }
      const completed = options.store.completeIssueTriageComment({
        commandId: command.id,
        workerId: command.workerId,
        fence: command.fence,
        at: options.now().toISOString(),
        commentId: published.value.commentId,
        url: published.value.url,
      })
      return completed
        ? ok(published.value)
        : err('GitHub accepted the issue triage comment, but the local issue changed. Refresh before retrying.')
    },
  }
}
