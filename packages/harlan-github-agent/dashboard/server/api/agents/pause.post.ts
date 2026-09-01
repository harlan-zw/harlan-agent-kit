import { defineEventHandler } from 'h3'
import { assertDevMock, updateMock } from '../../utils/mock.ts'

export default defineEventHandler((event) => {
  assertDevMock(event)
  const pausedAt = new Date().toISOString()
  updateMock(current => ({ ...current, agentControl: { _tag: 'Paused', pausedAt, safeToRestart: current.agents.length === 0 }, agentStart: { _tag: 'Paused' } }))
  return { _tag: 'Paused', pausedAt }
})
