import { defineEventHandler, getRouterParam } from 'h3'
import { assertDevMock } from '../../../utils/mock.ts'
import { mockStopSession } from '../../../utils/session-mock.ts'

export default defineEventHandler((event) => {
  assertDevMock(event)
  return mockStopSession(getRouterParam(event, 'id') ?? '')
})
