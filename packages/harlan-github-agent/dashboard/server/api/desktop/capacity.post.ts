import { defineEventHandler, readBody } from 'h3'
import { parseDesktopMemory } from '../../../../src/desktop-protocol.ts'
import { assertDevMock, updateMock } from '../../utils/mock.ts'

export default defineEventHandler(async (event) => {
  assertDevMock(event)
  const memoryGiB = parseDesktopMemory(await readBody(event))
  updateMock(current => ({
    ...current,
    ...(current.desktop?.report === null || current.desktop?.report === undefined
      ? {}
      : {
          desktop: { ...current.desktop, report: { ...current.desktop.report, memoryGiB } },
        }),
  }))
  return { memoryGiB }
})
