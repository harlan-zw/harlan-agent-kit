import type { DashboardTask, QueueEntry, ReviewRerunResult } from '../../../../src/types.ts'
import { createError, defineEventHandler, readBody } from 'h3'
import { assertDevMock, currentMockSnapshot, mockTaskId, updateMock } from '../../utils/mock.ts'

/**
 * Dev-only stand-in for the controller's rerun endpoint.
 *
 * Refuses the same way the store does: the pull request must still be at the
 * head the Review run saw. Accepting queues one adversarial review Task, and a
 * Queue entry when the board does not already show the Item.
 */
export default defineEventHandler(async (event): Promise<ReviewRerunResult> => {
  assertDevMock(event)
  const body = await readBody<{ repository?: unknown, pullRequestNumber?: unknown, revisionId?: unknown }>(event)
  if (typeof body?.repository !== 'string' || typeof body.pullRequestNumber !== 'number' || typeof body.revisionId !== 'string')
    throw createError({ statusCode: 400, statusMessage: 'repository, pullRequestNumber, and revisionId are required.' })
  const { repository, pullRequestNumber, revisionId } = body

  const current = currentMockSnapshot()
  const item = current.items.find(candidate => candidate.kind === 'pull_request' && candidate.repository === repository && candidate.number === pullRequestNumber)
  if (item === undefined)
    throw createError({ statusCode: 404, statusMessage: 'Rerun refused: the pull request is no longer watched.' })
  if (item.revisionId !== revisionId)
    throw createError({ statusCode: 409, statusMessage: 'Rerun refused: the head commit moved. Reload.' })

  const queued = current.tasks.find(task =>
    task.kind === 'adversarial_review'
    && task.repository === repository
    && task.pullRequestNumber === pullRequestNumber
    && task.revisionId === revisionId
    && (task.state._tag === 'Queued' || task.state._tag === 'Running'),
  )
  if (queued !== undefined)
    return { _tag: 'AlreadyQueued', taskId: queued.id }

  const now = new Date().toISOString()
  const task: DashboardTask = {
    id: mockTaskId(),
    kind: 'adversarial_review',
    repository,
    pullRequestNumber,
    revisionId,
    state: { _tag: 'Queued' },
    updatedAt: now,
    progress: { percent: 0, label: 'Starting' },
  }
  const onBoard = current.queue.some(entry => entry.repository === repository && entry.number === pullRequestNumber)
  const entry: QueueEntry = {
    kind: 'pull_request',
    position: current.queue.length + 1,
    revisionId,
    repository,
    repositoryUrl: `https://github.com/${repository}`,
    number: pullRequestNumber,
    title: item.title,
    author: item.author,
    subjectUrl: item.url,
    headSha: item.headSha,
    commitUrl: `https://github.com/${repository}/commit/${item.headSha}`,
    createdAt: now,
    updatedAt: now,
    state: { _tag: 'Queued', work: 'adversarial_review' },
  }
  updateMock(state => ({
    ...state,
    tasks: [...state.tasks, task],
    queue: onBoard ? state.queue : [...state.queue, entry],
  }))
  return { _tag: 'Queued', taskId: task.id }
})
