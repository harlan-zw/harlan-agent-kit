import type { GitHubChecksSnapshot, RunnerLostRecoverySource } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { GitHubPullRequestItem, RepositoryMapping } from './types.ts'
import { err, ok } from './result.ts'

export interface RunnerLostRecoveryOptions {
  repository: RepositoryMapping
  github: RunnerLostRecoverySource
  store: Pick<JournalStore, 'listRunnerLostIncidents' | 'mayWriteRepository' | 'resolveRunnerLostIncident'>
  now: () => Date
}

function checksProveRunnerRecovery(snapshot: GitHubChecksSnapshot): boolean {
  if (snapshot._tag !== 'Available' || snapshot.checks.length === 0)
    return false
  return snapshot.checks.every(check => check.status === 'completed'
    && check.failure._tag !== 'RunnerLost' && check.failure._tag !== 'Unknown'
    && (['success', 'skipped', 'neutral'].includes(check.conclusion ?? '')
      || (check.conclusion === 'failure' && check.failure._tag === 'StepFailed')))
    && snapshot.checks.some(check => check.conclusion === 'success' || check.failure._tag === 'StepFailed')
}

function identities(items: Array<Pick<GitHubPullRequestItem, 'number' | 'headSha' | 'baseSha' | 'baseRef'>>): string {
  return JSON.stringify(items.map(item => [item.number, item.headSha, item.baseSha, item.baseRef])
    .sort((left, right) => Number(left[0]) - Number(right[0])))
}

/** Complete repository evidence retires a grouped runner warning, without changing CI gates. */
export async function resolveRecoveredRunnerIncidents(options: RunnerLostRecoveryOptions, signal: AbortSignal): Promise<Result<number, string>> {
  if (signal.aborted)
    return err('Runner recovery was aborted.')
  if (!options.store.mayWriteRepository(options.repository.github))
    return ok(0)
  const incidents = options.store.listRunnerLostIncidents(options.repository.github)
  if (incidents.length === 0)
    return ok(0)
  const sources = await options.github.getOpenPullRequestCheckSources(options.repository, signal)
  if (sources._tag === 'Err')
    return sources
  const base = await options.github.getDefaultBranchSnapshot(options.repository, signal)
  if (base._tag === 'Err')
    return base
  if (base.value.baseChecks._tag === 'Unavailable')
    return err(base.value.baseChecks.reason)
  if (!checksProveRunnerRecovery(base.value.baseChecks))
    return ok(0)
  const seen = new Set<string>([`base:${base.value.baseSha}`])
  for (const item of sources.value) {
    for (const role of ['head', 'base'] as const) {
      const sha = role === 'head' ? item.headSha : item.baseSha
      const key = `${role}:${sha}`
      if (seen.has(key))
        continue
      seen.add(key)
      if (signal.aborted)
        return err('Runner recovery was aborted.')
      const checks = await options.github.getCommitChecks(options.repository, sha, role, signal)
      if (checks._tag === 'Unavailable')
        return err(checks.reason)
      if (!checksProveRunnerRecovery(checks))
        return ok(0)
    }
  }
  const current = await options.github.getOpenPullRequestCheckSources(options.repository, signal)
  if (current._tag === 'Err')
    return current
  if (identities(current.value) !== identities(sources.value))
    return ok(0)
  const currentBase = await options.github.getDefaultBranchSnapshot(options.repository, signal)
  if (currentBase._tag === 'Err')
    return currentBase
  if (signal.aborted)
    return err('Runner recovery was aborted.')
  if (currentBase.value.baseChecks._tag === 'Unavailable')
    return err(currentBase.value.baseChecks.reason)
  if (currentBase.value.baseSha !== base.value.baseSha || !checksProveRunnerRecovery(currentBase.value.baseChecks))
    return ok(0)
  return ok(incidents.filter(incident => options.store.resolveRunnerLostIncident({
    incident,
    repository: options.repository,
    at: options.now().toISOString(),
  })).length)
}
