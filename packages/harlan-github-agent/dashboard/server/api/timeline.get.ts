import { defineEventHandler } from 'h3'
import { assertDevMock } from '../utils/mock.ts'
import { mockTimelineHistory } from '../utils/timeline-mock.ts'

/** Dev only. The Service answers `/api/timeline` from the journal; this mock answers in its shape. */
export default defineEventHandler((event) => {
  assertDevMock(event)
  return mockTimelineHistory()
})
