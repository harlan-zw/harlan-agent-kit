import type { AgentFeedback, AgentFeedbackInput, RecordAgentFeedbackResult } from '../../../../src/types.ts'
import { createError, defineEventHandler, readBody } from 'h3'
import { assertDevMock, currentMockSnapshot, updateMock } from '../../utils/mock.ts'

/**
 * Parses the one judgment the dashboard sends. Noisy and Wrong need a reason;
 * Useful may carry one or none.
 */
function parseFeedback(value: unknown): AgentFeedbackInput | undefined {
  if (typeof value !== 'object' || value === null)
    return undefined
  const { _tag, reason } = value as { _tag?: unknown, reason?: unknown }
  if (_tag === 'Useful')
    return typeof reason === 'string' && reason.trim().length > 0 ? { _tag, reason: reason.trim() } : { _tag, reason: null }
  if ((_tag === 'Noisy' || _tag === 'Wrong') && typeof reason === 'string' && reason.trim().length > 0)
    return { _tag, reason: reason.trim() }
  return undefined
}

/** Dev-only stand-in for recording Agent feedback on one Review run. */
export default defineEventHandler(async (event): Promise<RecordAgentFeedbackResult> => {
  assertDevMock(event)
  const body = await readBody<{ reviewRunId?: unknown, feedback?: unknown }>(event)
  const feedback = parseFeedback(body?.feedback)
  if (typeof body?.reviewRunId !== 'string' || feedback === undefined)
    throw createError({ statusCode: 400, statusMessage: 'reviewRunId and a feedback verdict are required. Noisy and Wrong need a reason.' })
  const reviewRunId = body.reviewRunId

  const exists = currentMockSnapshot().agents.some(agent => agent._tag === 'ReviewAgent' && agent.id === reviewRunId)
  if (!exists)
    throw createError({ statusCode: 404, statusMessage: 'Feedback refused: the Review run was not found.' })

  const recorded: AgentFeedback = { ...feedback, updatedAt: new Date().toISOString() }
  updateMock(state => ({
    ...state,
    agents: state.agents.map(agent => agent._tag === 'ReviewAgent' && agent.id === reviewRunId ? { ...agent, feedback: recorded } : agent),
  }))
  return { _tag: 'Recorded', feedback: recorded }
})
