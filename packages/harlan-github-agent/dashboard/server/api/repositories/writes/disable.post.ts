import { defineEventHandler } from 'h3'
import { assertDevMock } from '../../../utils/mock.ts'
import { setMockRepositoryWrites } from '../../../utils/watching-mock.ts'

export default defineEventHandler(async (event) => {
  assertDevMock(event)
  return setMockRepositoryWrites(event, false)
})
