import type { ActiveAgent, DashboardRoutineRun } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { agentLogs, selectAgentLog } from '../dashboard/app/utils/agent-logs.ts'
import { dashboardSnapshot } from './fixtures.ts'

const at = '2026-10-08T12:00:00.000Z'
const agent: ActiveAgent = {
  _tag: 'ActiveAgent',
  id: 'a'.repeat(64),
  provider: 'opencode',
  role: 'adversarial_review',
  session: { _tag: 'Starting' },
  repository: 'harlan-zw/example',
  repositoryUrl: 'https://github.com/harlan-zw/example',
  subjectKind: 'pull_request',
  itemNumber: 24,
  title: 'Fix parser',
  author: 'harlan-zw',
  subjectUrl: 'https://github.com/harlan-zw/example/pull/24',
  startedAt: at,
  updatedAt: at,
  progress: { percent: 40, label: 'Reviewing' },
  activity: [{ _tag: 'Command', at, command: 'pnpm test', output: 'failure', exitCode: 1 }],
  state: { _tag: 'Working', workerId: 'worker', fence: 1, leaseExpiresAt: at },
}
const run: DashboardRoutineRun = {
  id: 'owner/site:ci-review:2026-10-08',
  routineId: 'ci-review',
  repository: 'owner/site',
  name: 'ci-review',
  scheduledFor: at,
  specSha: 'abc123',
  mode: 'report',
  state: { _tag: 'Running', workerId: 'routine', leaseExpiresAt: at },
  fence: 1,
  attempts: 1,
  progress: { percent: 35, label: 'Reviewing' },
  createdAt: at,
  updatedAt: at,
  usage: { _tag: 'Unavailable' },
  candidates: [],
  activity: [{ _tag: 'Reasoning', at, text: 'Checking logs' }],
  reportState: null,
}

describe('read-only Agent logs', () => {
  it('shows loading before the first dashboard response', () => {
    expect(selectAgentLog(dashboardSnapshot({ generatedAt: '' }), agent.id)).toEqual({ _tag: 'Loading' })
  })
  it('includes a Task before its native session connects and assigns both hosts from runtime facts', () => {
    const logs = agentLogs(dashboardSnapshot({ agents: [agent], routineRuns: [run], hostTasks: [{ taskId: agent.id, host: 'desktop' }, { taskId: run.id, host: 'hogwild' }] }))
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: agent.id, host: 'desktop', activity: agent.activity }),
      expect.objectContaining({ id: run.id, host: 'hogwild', activity: run.activity }),
    ]))
  })
  it('keeps an unknown host explicit and excludes completed Routine runs', () => {
    const logs = agentLogs(dashboardSnapshot({ agents: [agent], routineRuns: [{ ...run, state: { _tag: 'Completed', evidence: 'Checked' } }] }))
    expect(logs.map(log => ({ id: log.id, host: log.host }))).toEqual([{ id: agent.id, host: null }])
  })
  it('updates command output and retains the selected logs after the Agent disappears', () => {
    const live = selectAgentLog(dashboardSnapshot({ agents: [agent] }), agent.id)
    const updated = selectAgentLog(dashboardSnapshot({ agents: [{ ...agent, activity: [{ _tag: 'Command', at, command: 'pnpm test', output: 'passed', exitCode: 0 }] }] }), agent.id, live)
    expect(updated).toMatchObject({ _tag: 'Live', log: { activity: [{ output: 'passed', exitCode: 0 }] } })
    expect(selectAgentLog(dashboardSnapshot(), agent.id, updated)).toEqual({ _tag: 'Retained', log: updated._tag === 'Live' ? updated.log : undefined })
    expect(selectAgentLog(dashboardSnapshot(), run.id, updated)).toEqual({ _tag: 'Unavailable', id: run.id })
  })
})
