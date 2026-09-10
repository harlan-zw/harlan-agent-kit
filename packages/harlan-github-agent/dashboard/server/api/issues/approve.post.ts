import type { DashboardTask, IssueApprovalResult } from '../../../../src/types.ts'
import { createError, defineEventHandler, readBody } from 'h3'
import { assertDevMock, currentMockSnapshot, mockTaskId, updateMock } from '../../utils/mock.ts'

/**
 * Dev-only stand-in for the controller's issue Approval endpoint.
 *
 * Validates like `issueApprovalRequest` in src/app.ts. An entry awaiting
 * triage Approval becomes Queued triage. An entry awaiting work Approval
 * gains one Issue work Task and becomes Queued work.
 */
export default defineEventHandler(async (event): Promise<IssueApprovalResult> => {
  assertDevMock(event)
  const body = await readBody<{ repository?: unknown, issueNumber?: unknown, revisionId?: unknown }>(event)
  if (
    typeof body?.repository !== 'string' || !/^[^/]+\/[^/]+$/.test(body.repository)
    || !Number.isSafeInteger(body.issueNumber) || (body.issueNumber as number) < 1
    || typeof body.revisionId !== 'string' || !/^[a-f\d]{64}$/.test(body.revisionId)
  ) {
    throw createError({ statusCode: 400, statusMessage: 'A valid issue Approval is required.' })
  }
  const { repository, revisionId } = body
  const issueNumber = body.issueNumber as number

  const current = currentMockSnapshot()
  const entry = current.queue.find(candidate => candidate.kind === 'issue' && candidate.repository === repository && candidate.number === issueNumber)
  if (entry === undefined)
    throw createError({ statusCode: 404, statusMessage: 'The issue is no longer open.' })
  if (entry.revisionId !== revisionId)
    throw createError({ statusCode: 409, statusMessage: 'The issue changed. Refresh before approving it.' })
  if (entry.state._tag !== 'AwaitingApproval' || entry.state.kind === 'review')
    throw createError({ statusCode: 409, statusMessage: 'Nothing on this issue is waiting for approval.' })

  const now = new Date().toISOString()
  if (entry.state.kind === 'issue_triage') {
    const triage = current.tasks.find(task => task.kind === 'issue_triage' && task.repository === repository && task.issueNumber === issueNumber && task.revisionId === revisionId)
    const task: DashboardTask = triage ?? {
      id: mockTaskId(),
      kind: 'issue_triage',
      repository,
      issueNumber,
      revisionId,
      state: { _tag: 'Queued' },
      updatedAt: now,
      progress: { percent: 0, label: 'Starting' },
    }
    updateMock(state => ({
      ...state,
      tasks: triage === undefined ? [...state.tasks, task] : state.tasks,
      queue: state.queue.map(candidate => candidate === entry ? { ...candidate, state: { _tag: 'Queued', work: 'issue_triage' }, updatedAt: now } : candidate),
    }))
    return { _tag: 'Approved', work: 'issue_triage', taskId: task.id }
  }

  const queued = current.tasks.find(task => task.kind === 'issue_work' && task.repository === repository && task.issueNumber === issueNumber && task.revisionId === revisionId)
  if (queued !== undefined)
    return { _tag: 'Duplicate', work: 'issue_work', taskId: queued.id }
  const task: DashboardTask = {
    id: mockTaskId(),
    kind: 'issue_work',
    repository,
    issueNumber,
    revisionId,
    state: { _tag: 'Queued' },
    updatedAt: now,
    progress: { percent: 0, label: 'Starting' },
  }
  updateMock(state => ({
    ...state,
    tasks: [...state.tasks, task],
    queue: state.queue.map(candidate => candidate === entry ? { ...candidate, state: { _tag: 'Queued', work: 'issue_work' }, updatedAt: now } : candidate),
  }))
  return { _tag: 'Approved', work: 'issue_work', taskId: task.id }
})
