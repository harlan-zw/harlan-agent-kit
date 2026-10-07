import type { AgentPermitPool } from './agent-permit-pool.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { ClaimedReviewFixTask, Incident, RepositoryMapping } from './types.ts'
import type { PreparedConflictPublication } from './worktree.ts'
import { err, ok } from './result.ts'
import { runClaimedTask } from './task-scheduler.ts'

export interface RepairRecoveryProof {
  _tag: 'RepairRecovery'
  commitSha: string
  originalFence: number
  originalFailure: string
}

export interface RepairRecoveryTarget {
  task: Omit<ClaimedReviewFixTask, 'state'>
  fence: number
  proof: RepairRecoveryProof
  report: { summary: string, checks: string[] }
}

export interface RepairRecoveryArtifact {
  parentSha: string
  retainedRef: string
  changedPaths: string[]
  regressionPaths: string[]
}

export type RepairRecoveryRequest
  = | { _tag: 'Plan', taskId: string, commitSha: string }
    | { _tag: 'Apply', taskId: string, commitSha: string, expectedBase: string }

/** An Incident offers inspection only. The controller rechecks stored proof and authority before Apply. */
export function repairRecoveryCandidate(incident: Pick<Incident, 'scope' | 'message' | 'recovery'>): Extract<RepairRecoveryRequest, { _tag: 'Plan' }> | null {
  if (incident.scope._tag !== 'Task' || incident.recovery._tag === 'Retrying')
    return null
  const proof = repairRecoveryProof({ taskId: incident.scope.taskId, reason: incident.message, evidence: null, fence: 1 })
  return proof === null ? null : { _tag: 'Plan', taskId: incident.scope.taskId, commitSha: proof.commitSha }
}

export interface RepairRecoveryPlan extends RepairRecoveryArtifact {
  _tag: 'Plan'
  taskId: string
  repository: string
  pullRequestNumber: number
  commitSha: string
  expectedBase: string
  operation: 'Reuse' | 'Port'
  checks: string[]
}

export type RepairRecoveryResponse = RepairRecoveryPlan | { _tag: 'Accepted', taskId: string, fence: number }

export function parseRepairRecoveryResponse(value: unknown): Result<RepairRecoveryResponse, string> {
  if (typeof value !== 'object' || value === null)
    return err('The Service returned invalid Repair recovery data.')
  const input = value as Record<string, unknown>
  if (typeof input.taskId !== 'string' || !/^logged-finding:[a-f\d]{64}$/.test(input.taskId))
    return err('The Service returned an invalid Repair Task ID.')
  if (input._tag === 'Accepted' && Number.isSafeInteger(input.fence) && Number(input.fence) > 0)
    return ok({ _tag: 'Accepted', taskId: input.taskId, fence: Number(input.fence) })
  const strings = ['repository', 'retainedRef'] as const
  const shas = ['commitSha', 'expectedBase', 'parentSha'] as const
  const lists = ['changedPaths', 'regressionPaths', 'checks'] as const
  if (input._tag !== 'Plan' || !strings.every(key => typeof input[key] === 'string')
    || !shas.every(key => typeof input[key] === 'string' && /^[a-f\d]{40}$/.test(input[key]))
    || !lists.every(key => Array.isArray(input[key]) && input[key].every(entry => typeof entry === 'string'))
    || !Number.isSafeInteger(input.pullRequestNumber) || Number(input.pullRequestNumber) < 1
    || (input.operation !== 'Reuse' && input.operation !== 'Port')) {
    return err('The Service returned an invalid Repair recovery Plan.')
  }
  return ok(input as unknown as RepairRecoveryPlan)
}

export function parseRepairRecoveryRequest(value: unknown): Result<RepairRecoveryRequest, string> {
  if (typeof value !== 'object' || value === null)
    return err('Set a valid Repair recovery request.')
  const input = value as Record<string, unknown>
  if (typeof input.taskId !== 'string' || !/^logged-finding:[a-f\d]{64}$/.test(input.taskId)
    || typeof input.commitSha !== 'string' || !/^[a-f\d]{40}$/.test(input.commitSha)) {
    return err('Set the selected finding Task ID and retained commit SHA.')
  }
  if (input._tag === 'Plan')
    return ok({ _tag: 'Plan', taskId: input.taskId, commitSha: input.commitSha })
  if (input._tag === 'Apply' && typeof input.expectedBase === 'string' && /^[a-f\d]{40}$/.test(input.expectedBase))
    return ok({ _tag: 'Apply', taskId: input.taskId, commitSha: input.commitSha, expectedBase: input.expectedBase })
  return err('Apply needs the exact current base SHA. Otherwise, request a Plan.')
}

/** Retains the original pin failure across interrupted recovery and failed checks. */
export function repairRecoveryProof(input: { taskId: string, reason: string | null, evidence: string | null, fence: number }): RepairRecoveryProof | null {
  let proof: RepairRecoveryProof | null = null
  if (input.evidence !== null) {
    let saved: unknown
    try {
      saved = JSON.parse(input.evidence.startsWith('{') ? input.evidence : 'null')
    }
    catch {
      // Older Tasks store arbitrary text evidence. It grants no recovery authority.
      return null
    }
    if (typeof saved === 'object' && saved !== null) {
      const candidate = saved as Partial<RepairRecoveryProof>
      if (candidate._tag === 'RepairRecovery' && typeof candidate.commitSha === 'string'
        && typeof candidate.originalFailure === 'string' && Number.isSafeInteger(candidate.originalFence) && candidate.originalFence! > 0) {
        proof = candidate as RepairRecoveryProof
      }
    }
  }
  const reason = proof?.originalFailure ?? input.reason
  const match = reason?.match(/^Could not pin the repair artifact: .*invalid refspec '\+([a-f\d]{40}):refs\/harlan-github-agent\/publications\/(logged-finding:[a-f\d]{64})'$/)
  if (match === null || match === undefined || match[2] !== input.taskId || (proof !== null && proof.commitSha !== match[1]))
    return null
  return proof ?? { _tag: 'RepairRecovery', commitSha: match[1]!, originalFence: input.fence, originalFailure: reason! }
}

export interface RepairRecoveryWorktrees {
  inspectRecovery: (target: RepairRecoveryTarget, signal: AbortSignal) => Promise<Result<RepairRecoveryArtifact, string>>
  recover: (task: ClaimedReviewFixTask, target: RepairRecoveryTarget, plan: RepairRecoveryPlan, signal: AbortSignal) => Promise<Result<PreparedConflictPublication, string | { _tag: 'EvidenceRequired', reason: string }>>
}

export function createRepairRecoveryController(options: {
  store: Pick<JournalStore, 'inspectRepairRecovery' | 'claimRepairRecovery' | 'heartbeatTask' | 'failTask' | 'completeTask' | 'needsAttentionTask' | 'supersedeTask' | 'stagePublication'>
  github: {
    getPullRequestReviewSnapshot: (mapping: RepositoryMapping, number: number, signal: AbortSignal) => Promise<Result<{ pullRequest: ClaimedReviewFixTask['pullRequest'] }, unknown>>
    getDefaultBranchSnapshot: (mapping: RepositoryMapping, signal: AbortSignal) => Promise<Result<{ baseSha: string }, string>>
  }
  validateMapping: (mapping: RepositoryMapping) => Promise<Result<RepositoryMapping, string>>
  worktrees: RepairRecoveryWorktrees
  permits: AgentPermitPool
  canClaim: () => boolean
  acquireHost: (taskId: string) => { release: () => void } | null
  now: () => Date
  workerId: string
  onError: (error: unknown) => void
}) {
  const active = new Map<string, { controller: AbortController, done: Promise<unknown> }>()
  const currentBase = async (target: RepairRecoveryTarget, signal: AbortSignal): Promise<Result<string, string>> => {
    const current = await options.github.getPullRequestReviewSnapshot(target.task.repositoryMapping, target.task.pullRequestNumber, signal)
    if (current._tag === 'Err')
      return err('The controller could not read the current pull request.')
    const pull = current.value.pullRequest
    if (pull.state !== 'closed' || pull.mergedAt === null || pull.draft || pull.headSha !== target.task.pullRequest.headSha || pull.baseRef !== target.task.pullRequest.baseRef)
      return err('The selected finding no longer matches the merged pull request.')
    const base = await options.github.getDefaultBranchSnapshot(target.task.repositoryMapping, signal)
    return base._tag === 'Err' ? base : ok(base.value.baseSha)
  }
  return {
    async run(request: RepairRecoveryRequest): Promise<Result<RepairRecoveryResponse, string>> {
      const parsed = parseRepairRecoveryRequest(request)
      if (parsed._tag === 'Err')
        return parsed
      request = parsed.value
      const target = options.store.inspectRepairRecovery(request.taskId, request.commitSha)
      if (target._tag === 'Err')
        return target
      const validated = await options.validateMapping(target.value.task.repositoryMapping)
      if (validated._tag === 'Err')
        return validated
      target.value.task.repositoryMapping = validated.value
      const signal = AbortSignal.timeout(60_000)
      const base = await currentBase(target.value, signal)
      if (base._tag === 'Err')
        return base
      const artifact = await options.worktrees.inspectRecovery(target.value, signal)
      if (artifact._tag === 'Err')
        return artifact
      if (artifact.value.regressionPaths.length === 0)
        return err('The retained repair has no selected regression test. Add current evidence before recovery.')
      const plan: RepairRecoveryPlan = { ...artifact.value, _tag: 'Plan', taskId: request.taskId, repository: target.value.task.repository, pullRequestNumber: target.value.task.pullRequestNumber, commitSha: request.commitSha, expectedBase: base.value, operation: artifact.value.parentSha === base.value ? 'Reuse' : 'Port', checks: ['Selected regression tests', 'check', 'pnpm build when declared'] }
      if (request._tag === 'Plan')
        return ok(plan)
      if (request.expectedBase !== plan.expectedBase)
        return err('The default branch base changed. Request a new Plan.')
      if (!options.canClaim())
        return err('Service control prevents new Repair work.')
      const permit = options.permits.tryAcquire()
      if (permit === null)
        return err('No Agent slot is available for fresh Repair checks.')
      const host = options.acquireHost(request.taskId)
      if (host === null) {
        permit.release()
        return err('No local Agent slot is available for fresh Repair checks.')
      }
      let claimed: ReturnType<typeof options.store.claimRepairRecovery>
      try {
        claimed = options.store.claimRepairRecovery(target.value, options.workerId, options.now().toISOString(), 45 * 60_000)
      }
      catch (error) {
        host.release()
        permit.release()
        throw error
      }
      if (claimed._tag === 'Err') {
        host.release()
        permit.release()
        return claimed
      }
      const controller = new AbortController()
      const done = runClaimedTask(claimed.value, {
        leaseMilliseconds: 45 * 60_000,
        now: options.now,
        onError: options.onError,
        store: options.store,
        workerId: options.workerId,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45 * 60_000)]),
        worker: { run: async (task, signal) => {
          const before = await currentBase(target.value, signal)
          if (before._tag === 'Err')
            return before
          if (before.value !== plan.expectedBase)
            return err('The default branch base changed before recovery.')
          const recovered = await options.worktrees.recover(task, target.value, plan, signal)
          if (recovered._tag === 'Err') {
            return typeof recovered.error === 'string'
              ? err(recovered.error)
              : ok({ _tag: 'ActionRequired' as const, reason: recovered.error.reason, evidence: JSON.stringify(target.value.proof) })
          }
          const after = await currentBase(target.value, signal)
          if (after._tag === 'Err')
            return after
          if (after.value !== plan.expectedBase)
            return err('The default branch base changed during fresh checks.')
          const suffix = task.pickup!.finding.details.fingerprint.slice(0, 12)
          return ok({ _tag: 'Publish' as const, publication: {
            _tag: 'OpenPullRequest' as const,
            taskKind: 'review_fix' as const,
            pullRequestNumber: task.pullRequestNumber,
            pullRequestTitle: `fix: recover selected finding from #${task.pullRequestNumber}`,
            pullRequestBody: `Repairs the selected Review finding from #${task.pullRequestNumber}.\n\n${target.value.report.summary}\n\n> 🤖 AI disclosure: [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) modified this description. [My AI open-source policy](https://harlanzw.com/blog/ai-in-open-source).`,
            commitSha: recovered.value.commitSha,
            baseSha: recovered.value.baseSha,
            baseRef: task.repositoryMapping.defaultBranch,
            expectedHeadSha: plan.expectedBase,
            headRef: `${task.repositoryMapping.writablePullRequestHeadPrefixes[0]}review-${task.pullRequestNumber}-${task.pullRequest.headSha.slice(0, 12)}-${suffix}`,
            artifactRef: recovered.value.artifactRef,
            patchDigest: recovered.value.digest,
            changedFiles: recovered.value.changedFiles,
          } })
        } },
      }).then((result) => {
        if (result._tag === 'Aborted')
          options.store.failTask({ taskId: request.taskId, workerId: options.workerId, fence: claimed.value.state.fence, at: options.now().toISOString(), reason: 'Repair recovery was interrupted. Apply the retained commit again.' })
      }).catch(options.onError).finally(() => {
        host.release()
        permit.release()
        active.delete(request.taskId)
      })
      active.set(request.taskId, { controller, done })
      return ok({ _tag: 'Accepted', taskId: request.taskId, fence: claimed.value.state.fence })
    },
    async settle(taskId: string): Promise<boolean> {
      const recovery = active.get(taskId)
      if (recovery === undefined)
        return false
      await recovery.done
      return true
    },
    async stop(): Promise<void> {
      const recoveries = [...active.values()]
      recoveries.forEach(recovery => recovery.controller.abort())
      await Promise.all(recoveries.map(recovery => recovery.done))
    },
  }
}
