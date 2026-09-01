import type { PullRequestApprovalResult } from '../../../src/types.ts'
import { createError, defineEventHandler, readBody } from 'h3'
import { assertDevMock, currentMockSnapshot, updateMock } from '../utils/mock.ts'

/**
 * Dev-only stand-in for the controller's pull request Approval endpoint.
 *
 * Validates like `approvalRequest` in src/app.ts, then marks the Item approved
 * and moves its Queue entry from AwaitingApproval to Queued.
 */
export default defineEventHandler(async (event): Promise<PullRequestApprovalResult> => {
  assertDevMock(event)
  const body = await readBody<{ repository?: unknown, pullRequestNumber?: unknown, revisionId?: unknown, kind?: unknown }>(event)
  if (
    typeof body?.repository !== 'string' || !/^[^/]+\/[^/]+$/.test(body.repository)
    || !Number.isSafeInteger(body.pullRequestNumber) || (body.pullRequestNumber as number) < 1
    || typeof body.revisionId !== 'string' || !/^[a-f\d]{64}$/.test(body.revisionId)
    || body.kind !== 'review'
  ) {
    throw createError({ statusCode: 400, statusMessage: 'A valid pull request Approval is required.' })
  }
  const { repository, revisionId } = body
  const pullRequestNumber = body.pullRequestNumber as number

  const item = currentMockSnapshot().items.find(candidate => candidate.kind === 'pull_request' && candidate.repository === repository && candidate.number === pullRequestNumber)
  if (item === undefined)
    throw createError({ statusCode: 404, statusMessage: 'The pull request is no longer open.' })
  if (item.revisionId !== revisionId)
    throw createError({ statusCode: 409, statusMessage: 'The pull request changed. Refresh before approving it.' })
  if (item.approval._tag === 'NotRequired')
    throw createError({ statusCode: 409, statusMessage: 'This pull request does not require local approval.' })
  if (item.approval._tag === 'ReviewApproved')
    return { _tag: 'Duplicate', approval: item.approval }

  const approval = { _tag: 'ReviewApproved', approvedAt: new Date().toISOString() } as const
  updateMock(state => ({
    ...state,
    items: state.items.map(candidate => candidate === item ? { ...candidate, approval } : candidate),
    queue: state.queue.map(entry =>
      entry.repository === repository && entry.number === pullRequestNumber && entry.state._tag === 'AwaitingApproval'
        ? { ...entry, state: { _tag: 'Queued', work: 'adversarial_review' }, updatedAt: approval.approvedAt }
        : entry,
    ),
  }))
  return { _tag: 'Approved', approval }
})
