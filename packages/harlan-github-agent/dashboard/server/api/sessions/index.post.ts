import { defineEventHandler, readBody } from 'h3'
import { parseStartSession } from '../../../../src/session-protocol.ts'
import { assertDevMock } from '../../utils/mock.ts'
import { mockStartSession } from '../../utils/session-mock.ts'

export default defineEventHandler(async (event) => {
  assertDevMock(event)
  return mockStartSession(parseStartSession(await readBody(event)))
})
