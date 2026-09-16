import { createError, defineEventHandler, readBody } from 'h3'
import { parseAgentSlots } from '../../../../src/host-capacity.ts'
import { assertDevMock, currentMockSnapshot, updateMock } from '../../utils/mock.ts'

export default defineEventHandler(async (event) => {
  assertDevMock(event)
  const mock = currentMockSnapshot()
  const limits = mock.agentSlots
  const capacity = mock.hostCapacity
  if (limits === undefined || capacity === undefined)
    throw createError({ statusCode: 503, statusMessage: 'Agent slots cannot be set right now.' })
  let request: ReturnType<typeof parseAgentSlots>
  try {
    request = parseAgentSlots(await readBody(event), limits)
  }
  catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : 'The Agent slot request is invalid.' })
  }
  const next = request.host === 'hogwild'
    ? { ...capacity, localMaximum: request.slots }
    : { ...capacity, desktopMaximum: request.slots }
  updateMock(current => ({ ...current, hostCapacity: next }))
  return next
})
