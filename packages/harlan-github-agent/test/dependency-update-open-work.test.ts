import type { AgentEvent, AgentTurnRequest } from '../src/agent-provider.ts'
import type { GitHubSource } from '../src/github.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { candidateIssueCommands } from '../src/candidate-issue-controller.ts'
import { err, ok } from '../src/result.ts'
import { createRoutineScanWorker } from '../src/routine-worker.ts'
import { openJournalStore } from '../src/store.ts'
import { issueItem, repositoryMapping } from './fixtures.ts'

const routineId = 'harlan-zw/example:dependency-updates'
const at = (day: number) => `2026-08-${String(day).padStart(2, '0')}T07:00:00.000Z`
const minor = { manifest: 'package.json', name: 'vue', current: '3.5.0', latest: '3.6.0' }
const major = { manifest: 'package.json', name: 'nuxt', current: '4.0.0', latest: '5.0.0' }

type Store = ReturnType<typeof openJournalStore>

function dependencyStore(): Store {
  const store = openJournalStore(':memory:')
  store.syncRepositories([repositoryMapping()], at(1))
  store.setRepositoryWritesEnabled('harlan-zw/example', true)
  store.syncRoutines({
    repository: 'harlan-zw/example',
    specSha: 'abc123',
    entries: [{ name: 'dependency-updates', crons: ['0 7 * * 1'], timeZone: 'UTC', mode: 'propose', enabled: true }],
    at: at(1),
  })
  return store
}

/** One weekly scan whose Agent answers with these registry updates. Returns the prompt it read. */
async function scan(store: Store, day: number, updates: unknown[], getIssue: GitHubSource['getIssue'] = async (_repository, number) => ok(issueItem({ number }))): Promise<string> {
  store.openRoutineRun({ routineId, scheduledFor: at(day), specSha: 'abc123', at: at(day) })
  const task = store.claimNextRoutineRun('worker-1', at(day), 60 * 60_000)
  if (task === null)
    throw new Error('Expected a queued Routine run.')
  const prompts: string[] = []
  const provider = {
    name: 'codex' as const,
    runTurn: (request: AgentTurnRequest) => {
      prompts.push(request.prompt)
      return (async function* (): AsyncIterable<AgentEvent> {
        yield { _tag: 'SessionStarted', sessionId: 'session-1' }
        yield { _tag: 'Message', text: JSON.stringify({ outcome: 'complete', report: 'Registry scan completed.', updates }) }
        yield { _tag: 'TurnCompleted' }
      })()
    },
  }
  const result = await createRoutineScanWorker({
    github: { getIssue },
    githubEvidence: { collect: async () => ({ observedAt: at(day), issues: { _tag: 'Available', entries: [], truncated: false }, pullRequests: { _tag: 'Available', entries: [], truncated: false }, workflowRuns: { _tag: 'Unavailable', reason: 'Not read.' }, deployments: { _tag: 'Available', entries: [], truncated: false }, deploymentStatuses: [], jobLogs: { _tag: 'NotRequested' }, ownership: { _tag: 'NotRequested' } }) },
    logger: { error: () => undefined, info: () => undefined },
    now: () => new Date(at(day)),
    runtime: () => ({ profile: CODEX_AGENT_PROFILE, provider }),
    store,
    workspaces: { prepareRoutine: async () => ok({ path: '/tmp/routine', baseSha: 'abc123', headSha: 'abc123', defaultBranchSha: 'abc123' }) },
  }).run(task, new AbortController().signal)
  if (result._tag === 'Err')
    throw new Error(result.error)
  store.completeRoutineRun({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: at(day), evidence: result.value.evidence })
  return prompts[0] ?? ''
}

/** Files every staged issue, numbered from 7, and answers the fingerprints filed. */
function fileIssues(store: Store, day: number): string[] {
  const filed: string[] = []
  for (let command = store.claimNextCandidateIssue('publisher', at(day), 60_000); command !== null; command = store.claimNextCandidateIssue('publisher', at(day), 60_000)) {
    const issueNumber = 7 + filed.length
    store.completeCandidateIssue({ commandId: command.id, workerId: command.workerId, fence: command.fence, at: at(day), issueNumber, url: `https://github.com/harlan-zw/example/issues/${issueNumber}` })
    filed.push(command.fingerprint)
  }
  return filed
}

describe('dependency work open by kind', () => {
  it('refreshes closed proposals before the next scan without GitHub polling', async () => {
    const store = dependencyStore()
    try {
      await scan(store, 3, [minor, major])
      expect(fileIssues(store, 3)).toHaveLength(2)
      const read: number[] = []
      const prompt = await scan(store, 10, [minor, major].map(update => ({ ...update, latest: update.latest.replace(/\.0$/, '.1') })), async (_repository, number) => {
        read.push(number)
        return ok(issueItem({ number, state: 'closed', closureReason: 'completed' }))
      })

      expect(prompt).not.toContain('Stop before registry reads.')
      expect(store.listCandidates(routineId).slice(0, 2).map(candidate => candidate.result._tag)).toEqual(['Superseded', 'Superseded'])
      expect(fileIssues(store, 10).sort()).toEqual([
        expect.stringMatching(/^dependency-updates:major:/),
        expect.stringMatching(/^dependency-updates:minor-and-patch:/),
      ])
      expect(read).toEqual([7, 8])
    }
    finally {
      store.close()
    }
  })

  it.each([403, 404])('keeps held kinds when an exact issue read fails with %s', async (status) => {
    const store = dependencyStore()
    try {
      await scan(store, 3, [minor, major])
      expect(fileIssues(store, 3)).toHaveLength(2)

      await expect(scan(store, 10, [minor, major], async () => err({
        repository: 'harlan-zw/example',
        message: 'Issue unavailable.',
        status,
      }))).rejects.toThrow('Issue unavailable.')

      expect(store.listOpenCandidateIssues(routineId).map(issue => issue.issueNumber)).toEqual([7, 8])
      expect(fileIssues(store, 10)).toEqual([])
    }
    finally {
      store.close()
    }
  })

  it.each([
    ['major', major, minor, 'dependency-updates:minor-and-patch:'],
    ['minor and patch', minor, major, 'dependency-updates:major:'],
  ])('files the other kind while a %s issue is open', async (_kind, open, other, filedPrefix) => {
    const store = dependencyStore()
    try {
      await scan(store, 3, [open])
      expect(fileIssues(store, 3)).toHaveLength(1)

      const prompt = await scan(store, 10, [open, other].map(update => ({ ...update, latest: update.latest.replace(/\.0$/, '.1') })))

      expect(prompt).toContain('#7')
      expect(fileIssues(store, 10)).toEqual([expect.stringMatching(new RegExp(`^${filedPrefix}`))])
    }
    finally {
      store.close()
    }
  })

  it('treats a combined issue from before the split as holding both kinds', async () => {
    const store = dependencyStore()
    try {
      store.openRoutineRun({ routineId, scheduledFor: at(2), specSha: 'abc123', at: at(2) })
      const runId = store.listRoutineRuns(routineId)[0]!.id
      store.recordCandidates({ routineId, runId, candidates: [{ fingerprint: `dependency-updates:${'a'.repeat(64)}`, title: 'chore(deps): update dependencies together', target: 'package.json', claim: 'Attempt every listed update.', verification: 'pnpm check', estimatedChangedFiles: 2 }], at: at(2) })
      store.stageCandidateIssues({ commands: candidateIssueCommands(store.listCandidates(routineId), { repository: 'harlan-zw/example', name: 'dependency-updates', scheduledFor: at(2) }), at: at(2) })
      expect(fileIssues(store, 2)).toHaveLength(1)
      const queued = store.claimNextRoutineRun('worker-1', at(2), 60_000)
      store.completeRoutineRun({ taskId: queued!.id, workerId: queued!.state.workerId, fence: queued!.state.fence, at: at(2), evidence: 'Filed before the split.' })

      const prompt = await scan(store, 10, [minor, major])

      expect(prompt).toContain('#7 holds minor and patch work and major work')
      expect(prompt).toContain('Stop before registry reads.')
      expect(fileIssues(store, 10)).toEqual([])
    }
    finally {
      store.close()
    }
  })
})
