import { defineEventHandler, getRouterParam } from 'h3'
import { assertDevMock } from '../../utils/mock.ts'
import { mockSession } from '../../utils/session-mock.ts'

export default defineEventHandler((event) => {
  assertDevMock(event)
  return mockSession(getRouterParam(event, 'id') ?? '')
})
