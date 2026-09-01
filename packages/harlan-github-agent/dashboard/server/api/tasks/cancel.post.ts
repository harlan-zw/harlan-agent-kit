import { createError, defineEventHandler, readBody } from 'h3'
import { assertDevMock, currentMockSnapshot, updateMock } from '../../utils/mock.ts'

/**
 * Dev-only stand-in for the controller's cancel endpoint.
 *
 * Validates like `cancelTaskRequest` in src/app.ts, then drops the Task, the
 * agent running it, and its Queue entry so the next snapshot shows the cancel.
 */
export default defineEventHandler(async (event): Promise<{ _tag: 'Cancelled' }> => {
  assertDevMock(event)
  const body = await readBody<{ taskId?: unknown }>(event)
  if (typeof body?.taskId !== 'string' || !/^[a-f\d]{64}$/.test(body.taskId))
    throw createError({ statusCode: 400, statusMessage: 'A valid task ID is required.' })
  const { taskId } = body

  const task = currentMockSnapshot().tasks.find(candidate => candidate.id === taskId)
  if (task === undefined)
    throw createError({ statusCode: 404, statusMessage: 'The task was not found.' })
  if (task.state._tag !== 'Queued' && task.state._tag !== 'Running')
    throw createError({ statusCode: 409, statusMessage: 'The task already finished.' })

  updateMock(state => ({
    ...state,
    tasks: state.tasks.filter(candidate => candidate.id !== taskId),
    agents: state.agents.filter(agent => agent.id !== taskId),
    queue: state.queue.filter(entry => !(entry.repository === task.repository && entry.revisionId === task.revisionId)),
  }))
  return { _tag: 'Cancelled' }
})
