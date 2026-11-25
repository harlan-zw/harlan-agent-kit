import type { Result } from './result.ts'
import type { TakeOwnershipStore } from './take-ownership-store.ts'
import type { CompletionSmokeAssertion, RepositoryMapping } from './types.ts'
import { createHash } from 'node:crypto'

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
  source:
    | { _tag: 'Push', sha: string, branch: string | null }
    | { _tag: 'WorkflowRun', sha: string, branch: string, repository: string }
  status: string | null
  conclusion: string | null
  url: string
}

export interface CompletionEvidence {
  mergeSha: string
  workflows: { name: string, url: string }[]
  smoke: { url: string, status: number, assertions?: SmokeEvidence[] }[]
}

type SmokeEvidence = { _tag: 'Revision', sha: string } | { _tag: 'BodyText' }

export type CompletionResult
  = | { _tag: 'Pending', reason: string }
    | { _tag: 'ActionRequired', reason: string, workflowUrl?: string }
    | { _tag: 'Completed', evidence: CompletionEvidence }

export interface CompletionSource {
  workflows: (repository: RepositoryMapping, target: CompletionTarget, signal: AbortSignal) => Promise<Result<CompletionWorkflow[], string>>
  smoke: (url: string, signal: AbortSignal) => Promise<Result<Response, string>>
}

const smokeBodyLimit = 1024 * 1024

async function responseContains(response: Response, text: string): Promise<boolean> {
  if (response.body === null)
    return false
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let remaining = smokeBodyLimit
  let tail = ''
  try {
    while (remaining > 0) {
      const chunk = await reader.read()
      if (chunk.done)
        break
      const prefix = chunk.value.subarray(0, remaining)
      remaining -= prefix.length
      const content = tail + decoder.decode(prefix, { stream: true })
      if (content.includes(text))
        return true
      tail = content.slice(Math.max(0, content.length - text.length + 1))
    }
    return (tail + decoder.decode()).includes(text)
  }
  finally {
    await reader.cancel()
  }
}

/** Reads delivery evidence. It never deploys, repairs, or publishes GitHub state. */
export async function verifyCompletion(repository: RepositoryMapping, target: CompletionTarget, source: CompletionSource, signal: AbortSignal): Promise<CompletionResult> {
  const policy = repository.takeOwnership
  if (!repository.enabled || repository.ownership !== 'owned' || policy._tag === 'Disabled')
    return { _tag: 'ActionRequired', reason: 'Take Ownership is disabled for this repository.' }
  const evidence: CompletionEvidence = { mergeSha: target.mergeSha, workflows: [], smoke: [] }
  if (policy.requiredWorkflows.length > 0) {
    const read = await source.workflows(repository, target, signal)
    if (read._tag === 'Err')
      return { _tag: 'Pending', reason: read.error }
    for (const name of policy.requiredWorkflows) {
      const matches = read.value.filter(run => run.source.sha === target.mergeSha
        && run.source.branch === repository.defaultBranch
        && (run.source._tag === 'Push' || run.source.repository.toLowerCase() === repository.github.toLowerCase())
        && (run.name === name || run.path.split('@')[0] === `.github/workflows/${name}` || run.path.split('@')[0] === name))
      if (new Set(matches.map(run => run.path.split('@')[0])).size > 1)
        return { _tag: 'ActionRequired', reason: `Workflow ${name} matches multiple workflow files. Use one workflow filename.` }
      const run = matches.sort((a, b) => b.id - a.id)[0]
      if (run === undefined)
        return { _tag: 'Pending', reason: `Workflow ${name} has no delivery run for ${target.mergeSha}.` }
      if (run.status !== 'completed')
        return { _tag: 'Pending', reason: `Workflow ${name} is ${run.status ?? 'pending'}.` }
      if (run.conclusion !== 'success')
        return { _tag: 'ActionRequired', reason: `GitHub reported ${run.conclusion ?? 'no result'} for ${name}.`, workflowUrl: run.url }
      evidence.workflows.push({ name, url: run.url })
    }
  }
  const origin = URL.parse(policy.productionUrl)
  if (origin === null || origin.protocol !== 'https:' || origin.username || origin.password)
    return { _tag: 'ActionRequired', reason: 'Take Ownership requires an HTTPS production URL without credentials.' }
  const smokeChecks = new Map<string, readonly CompletionSmokeAssertion[]>(policy.smokePaths.map(path => [path, []]))
  for (const check of policy.smokeChecks ?? [])
    smokeChecks.set(check.path, check.assertions)
  for (const [path, assertions] of smokeChecks) {
    const url = URL.parse(path, origin)
    if (!path.startsWith('/') || url === null || url.origin !== origin.origin || url.username || url.password)
      return { _tag: 'ActionRequired', reason: 'Every smoke path must stay on the production origin.' }
    const read = await source.smoke(url.href, signal)
    if (read._tag === 'Err')
      return { _tag: 'Pending', reason: read.error }
    const response = read.value
    try {
      if (!response.ok)
        return { _tag: 'ActionRequired', reason: `Smoke request returned HTTP ${response.status}: ${url.href}` }
      const checked: SmokeEvidence[] = []
      for (const assertion of assertions) {
        if (assertion._tag === 'Revision') {
          const served = response.headers.get(assertion.header)?.trim().toLowerCase()
          if (served === undefined || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(served))
            return { _tag: 'Pending', reason: `Waiting for a valid ${assertion.header} header at ${url.href}.` }
          const expected = served.length === 64 ? createHash('sha256').update(target.mergeSha).digest('hex') : target.mergeSha
          if (served !== expected)
            return { _tag: 'Pending', reason: `The served revision at ${url.href} differs from merge commit ${target.mergeSha.slice(0, 12)}.` }
          checked.push({ _tag: 'Revision', sha: target.mergeSha })
        }
        else {
          if (!await responseContains(response, assertion.text))
            return { _tag: 'ActionRequired', reason: `Expected content is missing from the first 1 MiB at ${url.href}.` }
          checked.push({ _tag: 'BodyText' })
        }
      }
      evidence.smoke.push({ url: url.href, status: response.status, ...(checked.length === 0 ? {} : { assertions: checked }) })
    }
    finally {
      if (!response.bodyUsed)
        await response.body?.cancel()
    }
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
