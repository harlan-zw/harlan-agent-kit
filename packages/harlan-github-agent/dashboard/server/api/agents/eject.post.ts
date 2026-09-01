import { createError, defineEventHandler, readBody } from 'h3'
import { assertDevMock, currentMockSnapshot, updateMock } from '../../utils/mock.ts'

interface Ejected {
  _tag: 'Ejected'
  provider: 'codex' | 'opencode'
  sessionId: string
  repository: string
  itemNumber: number
}

/**
 * Dev-only stand-in for the controller's eject endpoint.
 *
 * Validates like `cancelTaskRequest` in src/app.ts, refuses an agent whose
 * session has not connected, then drops the agent, its Task, and its Queue
 * entry so the next snapshot shows the eject.
 */
export default defineEventHandler(async (event): Promise<Ejected> => {
  assertDevMock(event)
  const body = await readBody<{ taskId?: unknown }>(event)
  if (typeof body?.taskId !== 'string' || !/^[a-f\d]{64}$/.test(body.taskId))
    throw createError({ statusCode: 400, statusMessage: 'A valid task ID is required.' })
  const { taskId } = body

  const agent = currentMockSnapshot().agents.find(candidate => candidate._tag === 'ActiveAgent' && candidate.id === taskId)
  if (agent?._tag !== 'ActiveAgent')
    throw createError({ statusCode: 404, statusMessage: 'The running agent was not found.' })
  if (agent.session._tag !== 'Connected')
    throw createError({ statusCode: 409, statusMessage: 'The agent session is still starting.' })

  updateMock(state => ({
    ...state,
    agents: state.agents.filter(candidate => candidate.id !== taskId),
    tasks: state.tasks.filter(task => task.id !== taskId),
    queue: state.queue.filter(entry => !(entry.repository === agent.repository && entry.number === agent.itemNumber)),
  }))
  return { _tag: 'Ejected', provider: agent.provider, sessionId: agent.session.id, repository: agent.repository, itemNumber: agent.itemNumber }
})
