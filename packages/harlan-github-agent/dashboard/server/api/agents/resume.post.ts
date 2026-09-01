import { defineEventHandler } from 'h3'
import { assertDevMock, updateMock } from '../../utils/mock.ts'

export default defineEventHandler((event) => {
  assertDevMock(event)
  updateMock(current => ({ ...current, agentControl: { _tag: 'Running' }, agentStart: current.mutationsEnabled ? { _tag: 'Available' } : { _tag: 'WritesDisabled' } }))
  return { _tag: 'Running' }
})
