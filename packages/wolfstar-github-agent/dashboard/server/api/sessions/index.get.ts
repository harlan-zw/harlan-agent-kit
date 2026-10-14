import { defineEventHandler } from 'h3'
import { assertDevMock } from '../../utils/mock.ts'
import { mockSessionSnapshot } from '../../utils/session-mock.ts'

export default defineEventHandler((event) => {
  assertDevMock(event)
  return mockSessionSnapshot()
})
