import type { Result } from './result.ts'
import type { AgentFeedbackInput } from './types.ts'
import { err, ok } from './result.ts'

export interface RecordAgentFeedbackRequest {
  reviewRunId: string
  feedback: AgentFeedbackInput
}

function cleanReason(value: unknown): string | null | undefined {
  if (value === null || value === undefined)
    return null
  if (typeof value !== 'string')
    return undefined
  const reason = value.trim()
  return reason.length === 0 ? null : reason
}

/** Parses dashboard input once, before it enters the journal. */
export function parseAgentFeedback(value: unknown): Result<RecordAgentFeedbackRequest, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return err('A review and Agent feedback are required.')
  const body = value as Record<string, unknown>
  if (typeof body.reviewRunId !== 'string' || body.reviewRunId.trim() === '')
    return err('A valid review is required.')
  if (typeof body.feedback !== 'object' || body.feedback === null || Array.isArray(body.feedback))
    return err('Agent feedback must be Useful, Noisy, or Wrong.')
  const feedback = body.feedback as Record<string, unknown>
  const reason = cleanReason(feedback.reason)
  if (reason === undefined)
    return err('The Agent feedback reason must be text.')
  if (feedback._tag === 'Useful')
    return ok({ reviewRunId: body.reviewRunId, feedback: { _tag: 'Useful', reason } })
  if (feedback._tag !== 'Noisy' && feedback._tag !== 'Wrong')
    return err('Agent feedback must be Useful, Noisy, or Wrong.')
  if (reason === null)
    return err(`${feedback._tag} Agent feedback needs a reason.`)
  return ok({ reviewRunId: body.reviewRunId, feedback: { _tag: feedback._tag, reason } })
}
