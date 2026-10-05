import type { Result } from './result.ts'
import type { TakeOwnershipStore } from './take-ownership-store.ts'
import type { RepositoryMapping } from './types.ts'

export interface CompletionTarget {
  pullRequestNumber: number
  headSha: string
  mergeSha: string
  mergedAt: string
}

export interface CompletionWorkflow {
  id: number
  name?: string | null
  path: string
  sha: string
  branch: string | null
  event: string
  status: string | null
  conclusion: string | null
  url: string
}

export interface CompletionEvidence {
  mergeSha: string
  workflows: { name: string, url: string }[]
  smoke: { url: string, status: number }[]
}

export type CompletionResult
  = | { _tag: 'Pending', reason: string }
    | { _tag: 'ActionRequired', reason: string }
    | { _tag: 'Completed', evidence: CompletionEvidence }

export interface CompletionSource {
  workflows: (repository: RepositoryMapping, sha: string, signal: AbortSignal) => Promise<Result<CompletionWorkflow[], string>>
  smoke: (url: string, signal: AbortSignal) => Promise<Result<number, string>>
}

/** Reads delivery evidence. It never deploys, repairs, or publishes GitHub state. */
export async function verifyCompletion(repository: RepositoryMapping, target: CompletionTarget, source: CompletionSource, signal: AbortSignal): Promise<CompletionResult> {
  const policy = repository.takeOwnership
  if (!repository.enabled || repository.ownership !== 'owned' || policy._tag === 'Disabled')
    return { _tag: 'ActionRequired', reason: 'Take Ownership is disabled for this repository.' }
  const evidence: CompletionEvidence = { mergeSha: target.mergeSha, workflows: [], smoke: [] }
  if (policy.requiredWorkflows.length > 0) {
    const read = await source.workflows(repository, target.mergeSha, signal)
    if (read._tag === 'Err')
      return { _tag: 'Pending', reason: read.error }
    for (const name of policy.requiredWorkflows) {
      const matches = read.value.filter(run => run.sha === target.mergeSha
        && run.branch === repository.defaultBranch && run.event === 'push'
        && (run.name === name || run.path.split('@')[0] === `.github/workflows/${name}` || run.path.split('@')[0] === name))
      if (new Set(matches.map(run => run.path.split('@')[0])).size > 1)
        return { _tag: 'ActionRequired', reason: `Workflow ${name} matches multiple workflow files. Use one workflow filename.` }
      const run = matches.sort((a, b) => b.id - a.id)[0]
      if (run === undefined)
        return { _tag: 'Pending', reason: `Workflow ${name} has no default branch push run for ${target.mergeSha}.` }
      if (run.status !== 'completed')
        return { _tag: 'Pending', reason: `Workflow ${name} is ${run.status ?? 'pending'}.` }
      if (run.conclusion !== 'success')
        return { _tag: 'ActionRequired', reason: `Workflow ${name} concluded ${run.conclusion ?? 'unknown'}: ${run.url}` }
      evidence.workflows.push({ name, url: run.url })
    }
  }
  const origin = URL.parse(policy.productionUrl)
  if (origin === null || origin.protocol !== 'https:' || origin.username || origin.password)
    return { _tag: 'ActionRequired', reason: 'Take Ownership requires an HTTPS production URL without credentials.' }
  for (const path of policy.smokePaths) {
    const url = URL.parse(path, origin)
    if (!path.startsWith('/') || url === null || url.origin !== origin.origin || url.username || url.password)
      return { _tag: 'ActionRequired', reason: 'Every smoke path must stay on the production origin.' }
    const read = await source.smoke(url.href, signal)
    if (read._tag === 'Err')
      return { _tag: 'Pending', reason: read.error }
    if (read.value < 200 || read.value >= 300)
      return { _tag: 'ActionRequired', reason: `Smoke request returned HTTP ${read.value}: ${url.href}` }
    evidence.smoke.push({ url: url.href, status: read.value })
  }
  return { _tag: 'Completed', evidence }
}

/** One repository observation also resumes its durable Completion work. */
export async function runCompletionTask(options: {
  repository: RepositoryMapping
  store: TakeOwnershipStore
  source: CompletionSource
  workerId: string
  now: () => Date
}, signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    return
  const { repository, store, source, workerId, now } = options
  store.queueCompletionTasks(repository, now().toISOString())
  const task = store.claimCompletionTask(repository.github, workerId, now().toISOString())
  if (task === null)
    return
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
  const result = await verifyCompletion(repository, task.target, source, bounded).catch((error: unknown): CompletionResult => ({
    _tag: 'Pending',
    reason: error instanceof Error ? error.message : 'Completion could not read delivery evidence.',
  }))
  if (!signal.aborted)
    store.settleCompletionTask(task, result, now().toISOString())
}
