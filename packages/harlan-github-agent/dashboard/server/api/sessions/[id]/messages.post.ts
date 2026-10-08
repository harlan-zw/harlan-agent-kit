import { defineEventHandler, getRouterParam, readBody } from 'h3'
import { parseSessionMessage } from '../../../../../src/session-protocol.ts'
import { assertDevMock } from '../../../utils/mock.ts'
import { mockMessage } from '../../../utils/session-mock.ts'

export default defineEventHandler(async (event) => {
  assertDevMock(event)
  const request = parseSessionMessage(await readBody(event))
  return mockMessage(getRouterParam(event, 'id') ?? '', request.prompt, request.requestId)
})
