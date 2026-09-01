import { defineEventHandler } from 'h3'
import { assertDevMock } from '../../utils/mock.ts'
import { setMockItemDismissed } from '../../utils/watching-mock.ts'

export default defineEventHandler(async (event) => {
  assertDevMock(event)
  return setMockItemDismissed(event, true)
})
