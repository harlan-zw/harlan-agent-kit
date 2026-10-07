import type { RepairRecoveryResponse } from '../../../../src/repair-recovery.ts'
import { createError, defineEventHandler, readBody } from 'h3'
import { parseRepairRecoveryRequest } from '../../../../src/repair-recovery.ts'
import { assertDevMock, currentMockSnapshot, updateMock } from '../../utils/mock.ts'

/** Dev-only retained Repair. Production uses the controller's fresh authority checks. */
export default defineEventHandler(async (event): Promise<RepairRecoveryResponse> => {
  assertDevMock(event)
  const parsed = parseRepairRecoveryRequest(await readBody(event))
  if (parsed._tag === 'Err')
    throw createError({ statusCode: 400, statusMessage: parsed.error })
  const input = parsed.value
  const snapshot = currentMockSnapshot()
  const candidate = snapshot.repairRecoveryCandidates.find(entry => entry.taskId === input.taskId && entry.commitSha === input.commitSha)
  if (candidate === undefined)
    throw createError({ statusCode: 409, statusMessage: 'The retained Repair is unavailable. Request a new Plan.' })
  const expectedBase = 'f'.repeat(40)
  if (input._tag === 'Plan') {
    return {
      _tag: 'Plan',
      taskId: input.taskId,
      repository: candidate.repository,
      pullRequestNumber: candidate.pullRequestNumber,
      commitSha: input.commitSha,
      expectedBase,
      parentSha: 'a'.repeat(40),
      retainedRef: 'refs/harlan-github-agent/publications/demo',
      operation: 'Port',
      changedPaths: ['src/runtime/index.ts', 'test/runtime.test.ts'],
      regressionPaths: ['test/runtime.test.ts'],
      checks: ['pnpm check', 'pnpm build'],
    }
  }
  if (input.expectedBase !== expectedBase)
    throw createError({ statusCode: 409, statusMessage: 'The base changed. Request a new Plan.' })
  if (!snapshot.mutationsEnabled || snapshot.agentControl._tag !== 'Running' || snapshot.agentStart._tag !== 'Available')
    throw createError({ statusCode: 409, statusMessage: 'Service control prevents Repair recovery.' })
  updateMock(state => ({ ...state, incidents: state.incidents.filter(entry => entry.scope._tag !== 'Task' || entry.scope.taskId !== input.taskId), repairRecoveryCandidates: state.repairRecoveryCandidates.filter(entry => entry.taskId !== input.taskId) }))
  return { _tag: 'Accepted', taskId: input.taskId, fence: 1 }
})
