import { createError, defineEventHandler, readBody, setResponseStatus } from 'h3'
import { assertDevMock, currentMockSnapshot, updateMock } from '../../utils/mock.ts'

export default defineEventHandler(async (event) => {
  assertDevMock(event)
  const body = await readBody<{ source?: unknown }>(event)
  if (body?.source !== 'dashboard')
    throw createError({ statusCode: 400, statusMessage: 'source must be dashboard.' })
  const update = currentMockSnapshot().serviceUpdate
  if (update._tag !== 'Available')
    throw createError({ statusCode: 409, statusMessage: 'No service update is available.' })
  const request = {
    _tag: 'Requested' as const,
    id: crypto.randomUUID(),
    source: 'dashboard' as const,
    operation: { _tag: 'Update' as const, targetCommit: update.latestCommit },
    requestedAt: new Date().toISOString(),
  }
  updateMock(current => ({ ...current, restartRequest: request, agentStart: { _tag: 'RestartRequested' } }))
  setResponseStatus(event, 202)
  return request
})
