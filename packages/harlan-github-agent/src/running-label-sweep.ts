import type { GitHubAgentSource } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { RepositoryMapping } from './types.ts'
import { err, ok } from './result.ts'

export interface RunningLabelSweepOptions {
  github: Pick<GitHubAgentSource, 'clearRunningLabel' | 'listRunningLabelledItems'>
  repositories: RepositoryMapping[]
  store: Pick<JournalStore, 'listRunningTaskItems' | 'mayWriteRepository'>
}

export interface RunningLabelSweepOutcome {
  repository: string
  cleared: number[]
}

/**
 * Takes the Running label off every Item no Agent is working on.
 *
 * The label is written when a scheduler takes a lease and removed when it gives
 * one up. A process that dies in between never removes it, and a label that
 * says an Agent is working when none is reads worse than no label at all: it is
 * the one state a person cannot check for themselves.
 *
 * The journal is the answer, not a list of exact wordings or a timeout. An Item
 * with no Running Task has no Agent on it, whatever GitHub still shows.
 *
 * This reads one page of labelled Items per repository, so it runs at startup,
 * where a crash left the lie behind. Normal settlement removes the label
 * without it.
 */
export async function clearAbandonedRunningLabels(
  options: RunningLabelSweepOptions,
  signal: AbortSignal,
): Promise<Array<Result<RunningLabelSweepOutcome, string>>> {
  const running = new Set(options.store.listRunningTaskItems()
    .map(item => `${item.repository.toLowerCase()}#${item.itemNumber}`))

  const sweep = async (mapping: RepositoryMapping): Promise<Result<RunningLabelSweepOutcome, string>> => {
    const labelled = await options.github.listRunningLabelledItems(mapping, signal)
    if (labelled._tag === 'Err')
      return err(`${mapping.github}: ${labelled.error}`)
    const abandoned = labelled.value.filter(itemNumber =>
      !running.has(`${mapping.github.toLowerCase()}#${itemNumber}`))
    const cleared: number[] = []
    for (const itemNumber of abandoned) {
      const removed = await options.github.clearRunningLabel(mapping, itemNumber, signal)
      if (removed._tag === 'Err')
        return err(`${mapping.github}#${itemNumber}: ${removed.error}`)
      cleared.push(itemNumber)
    }
    return ok({ repository: mapping.github, cleared })
  }

  // A repository the controller may not write to cannot hold a label this
  // service wrote, so asking about it only reports the quarantine as a failure
  // on every start. Two quarantined repositories filed that Incident for days.
  const results: Array<Result<RunningLabelSweepOutcome, string>> = []
  const writable = options.repositories.filter((candidate: RepositoryMapping) =>
    candidate.enabled && options.store.mayWriteRepository(candidate.github))
  for (const mapping of writable)
    results.push(await sweep(mapping))
  return results
}
