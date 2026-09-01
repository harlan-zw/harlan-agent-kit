import { createError, defineEventHandler, readBody } from 'h3'
import { parseAgentSelection } from '../../../../src/agent-profile.ts'
import { assertDevMock, updateMock } from '../../utils/mock.ts'

export default defineEventHandler(async (event) => {
  assertDevMock(event)
  const parsed = parseAgentSelection(await readBody(event))
  if (parsed._tag === 'Err')
    throw createError({ statusCode: 400, statusMessage: parsed.error })
  const selection = parsed.value
  updateMock(current => ({
    ...current,
    agentSelection: selection,
    agentProfile: selection._tag === 'Pinned' ? { ...current.agentProfile, provider: selection.provider } : current.agentProfile,
  }))
  return selection
})
