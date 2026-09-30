import type { DefaultBranchSource, GitHubChecksSnapshot } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { RepositoryMapping } from './types.ts'
import { err, ok } from './result.ts'

export interface BaselineRepairSweepOptions {
  github: DefaultBranchSource
  now: () => Date
  repository: RepositoryMapping
  store: Pick<JournalStore, 'listActionRequiredBaselineRepairs' | 'retireActionRequiredBaselineRepair'>
}

const successfulConclusions = new Set(['success', 'skipped', 'neutral'])

function checksPassed(checks: GitHubChecksSnapshot): boolean {
  return checks._tag === 'Available' && checks.checks.length > 0
    && checks.checks.every(check => check.status === 'completed'
      && successfulConclusions.has(check.conclusion ?? '')
      && check.failure._tag !== 'RunnerLost')
}

/** Settles obsolete attention without starting another Agent turn. */
export async function retireObsoleteBaselineRepairs(options: BaselineRepairSweepOptions, signal: AbortSignal): Promise<Result<number, string>> {
  const candidates = options.store.listActionRequiredBaselineRepairs(options.repository.github)
  if (candidates.length === 0)
    return ok(0)
  if (candidates.some(candidate => candidate.defaultBranch !== options.repository.defaultBranch))
    return err('Repository policy changed before Baseline repair refresh.')
  const snapshot = await options.github.getDefaultBranchSnapshot(options.repository, signal)
  if (snapshot._tag === 'Err')
    return snapshot
  if (signal.aborted)
    return err('Baseline repair refresh was aborted.')
  const passed = checksPassed(snapshot.value.baseChecks)
  let retired = 0
  for (const candidate of candidates) {
    if (candidate.baseSha === snapshot.value.baseSha && !passed)
      continue
    if (options.store.retireActionRequiredBaselineRepair({
      candidate,
      evidence: { _tag: candidate.baseSha === snapshot.value.baseSha ? 'ChecksPassed' : 'BaseChanged', baseSha: snapshot.value.baseSha },
      at: options.now().toISOString(),
    })) {
      retired += 1
    }
  }
  if (snapshot.value.baseChecks._tag === 'Unavailable' && candidates.some(candidate => candidate.baseSha === snapshot.value.baseSha))
    return err(snapshot.value.baseChecks.reason)
  return ok(retired)
}
