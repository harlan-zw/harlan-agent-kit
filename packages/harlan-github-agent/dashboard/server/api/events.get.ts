import { createEventStream, defineEventHandler } from 'h3'
import { assertDevMock, currentMockSnapshot } from '../utils/mock.ts'

/** The real service pushes on change every two seconds. The mock pushes on a timer. */
export default defineEventHandler((event) => {
  assertDevMock(event)
  const stream = createEventStream(event)
  const push = (): void => {
    void stream.push({ event: 'state', data: JSON.stringify(currentMockSnapshot()) })
  }
  const timer = setInterval(push, 3_000)
  push()
  stream.onClosed(() => {
    clearInterval(timer)
  })
  return stream.send()
})
