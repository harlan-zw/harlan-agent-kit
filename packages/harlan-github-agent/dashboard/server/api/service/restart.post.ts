import { createError, defineEventHandler, readBody, setResponseStatus } from 'h3'
import { assertDevMock, updateMock } from '../../utils/mock.ts'

export default defineEventHandler(async (event) => {
  assertDevMock(event)
  const body = await readBody<{ source?: unknown }>(event)
  if (body?.source !== 'dashboard')
    throw createError({ statusCode: 400, statusMessage: 'source must be dashboard.' })
  const request = { _tag: 'Requested' as const, id: crypto.randomUUID(), source: 'dashboard' as const, operation: { _tag: 'Restart' as const }, requestedAt: new Date().toISOString() }
  updateMock(current => ({ ...current, restartRequest: request, agentStart: { _tag: 'RestartRequested' } }))
  setResponseStatus(event, 202)
  return request
})
