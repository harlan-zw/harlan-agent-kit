import { createError, defineEventHandler, readBody } from 'h3'
import { assertDevMock, updateMock } from '../../utils/mock.ts'

export default defineEventHandler(async (event) => {
  assertDevMock(event)
  const body = await readBody<{ mode?: unknown }>(event)
  if (body?.mode !== 'auto' && body?.mode !== 'manual')
    throw createError({ statusCode: 400, statusMessage: 'mode must be auto or manual.' })
  const mode = body.mode
  updateMock(current => ({ ...current, selectionMode: mode }))
  return { selectionMode: mode }
})
