import { createError, defineEventHandler } from 'h3'
import { assertDevMock } from '../../utils/mock.ts'

export default defineEventHandler((event) => {
  assertDevMock(event)
  throw createError({ statusCode: 403, message: 'Change Desktop memory in the host configuration.' })
})
