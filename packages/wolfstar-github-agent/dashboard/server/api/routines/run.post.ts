import type { DashboardRoutineRun } from '../../../../src/types.ts'
import { createError, defineEventHandler, readBody, setResponseStatus } from 'h3'
import { parseAgentSelection } from '../../../../src/agent-profile.ts'
import { assertDevMock, currentMockSnapshot, updateMock } from '../../utils/mock.ts'

export default defineEventHandler(async (event) => {
  assertDevMock(event)
  const body = await readBody(event)
  const routine = currentMockSnapshot().routines.find((routine) => routine.id === body?.routineId)
  if (routine === undefined) throw createError({ statusCode: 404, statusMessage: 'The Routine was not found.' })
  const parsed = parseAgentSelection({ ...body.agentSelection, _tag: 'Pinned' })
  if (parsed._tag === 'Err') throw createError({ statusCode: 400, statusMessage: parsed.error })
  if (parsed.value._tag !== 'Pinned') throw new Error('Expected a pinned Routine Agent selection.')
  const { provider, model, reasoningEffort } = parsed.value
  const at = new Date().toISOString()
  const scheduledFor = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString()
  const id = `${routine.id}:${scheduledFor}`
  if (currentMockSnapshot().routineRuns.some((run) => run.id === id))
    throw createError({
      statusCode: 409,
      statusMessage: 'A run already exists for this minute. Try again in a minute.',
    })
  const run: DashboardRoutineRun = {
    id,
    routineId: routine.id,
    repository: routine.repository,
    name: routine.name,
    scheduledFor,
    specSha: routine.specSha,
    mode: routine.mode,
    agentSelection: { provider, model, reasoningEffort },
    state: { _tag: 'Queued' },
    fence: 0,
    attempts: 0,
    progress: { percent: 0, label: 'Starting' },
    usage: { _tag: 'Unavailable' },
    candidates: [],
    activity: [],
    reportState: null,
    report: null,
    createdAt: at,
    updatedAt: at,
  }
  updateMock((current) => ({
    ...current,
    routineRuns: [run, ...current.routineRuns],
    routines: current.routines.map((entry) =>
      entry.id === routine.id ? { ...entry, lastRunAt: scheduledFor } : entry,
    ),
  }))
  setResponseStatus(event, 202)
  return run
})
