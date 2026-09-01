import type { ItemSummary, RepositoryStatus } from '../../../src/types.ts'

/**
 * Presentation logic for the Watching page. Pure and unit tested, so the page
 * holds layout and local filter state only.
 */

export function filterRepositories(list: readonly RepositoryStatus[], text: string): RepositoryStatus[] {
  const query = text.trim().toLowerCase()
  return query.length === 0
    ? [...list]
    : list.filter(repository => repository.github.toLowerCase().includes(query))
}

export type RepositoriesEmpty
  = | { _tag: 'None' }
    | { _tag: 'Filtered', text: string }

/** Why the repository table shows nothing, so the line can name the cause. */
export function repositoriesEmpty(total: number, text: string): RepositoriesEmpty | undefined {
  if (total === 0)
    return { _tag: 'None' }
  const query = text.trim()
  return query.length === 0 ? undefined : { _tag: 'Filtered', text: query }
}

export function repositoriesEmptyLine(empty: RepositoriesEmpty): string {
  return empty._tag === 'None'
    ? 'No repository mappings are enabled.'
    : `No repository matches "${empty.text}".`
}

export type RepositoryAction
  = | { _tag: 'Pause' }
    | { _tag: 'Resume' }
    | { _tag: 'EnableWrites' }
    | { _tag: 'DisableWrites' }

/**
 * Which menu items apply to one repository.
 *
 * An external watch has no repositories row on the controller, so a writes
 * change could only answer 404. The menu never offers it.
 */
export function repositoryActions(repository: RepositoryStatus): RepositoryAction[] {
  const actions: RepositoryAction[] = [repository.paused ? { _tag: 'Resume' } : { _tag: 'Pause' }]
  if (repository.ownership !== 'external')
    actions.push(repository.writesEnabled ? { _tag: 'DisableWrites' } : { _tag: 'EnableWrites' })
  return actions
}

export function repositoryActionLabel(action: RepositoryAction): string {
  switch (action._tag) {
    case 'Pause': return 'Pause'
    case 'Resume': return 'Resume'
    case 'EnableWrites': return 'Enable writes'
    case 'DisableWrites': return 'Disable writes'
  }
}

export function repositoryActionIcon(action: RepositoryAction): string {
  switch (action._tag) {
    case 'Pause': return 'i-octicon-stop-16'
    case 'Resume': return 'i-octicon-play-16'
    case 'EnableWrites': return 'i-octicon-unlock-16'
    case 'DisableWrites': return 'i-octicon-lock-16'
  }
}

export function repositoryWritesLabel(repository: RepositoryStatus): 'Enabled' | 'Disabled' | 'n/a' {
  if (repository.ownership === 'external')
    return 'n/a'
  return repository.writesEnabled ? 'Enabled' : 'Disabled'
}

export function repositoryAgentsLabel(repository: RepositoryStatus): 'Running' | 'Paused' {
  return repository.paused ? 'Paused' : 'Running'
}

export type OpenItemsFilter = 'all' | 'issue' | 'pull_request'

/** Dismissed items have their own group, so they never pad this list. */
export function openItemsFilter(items: readonly ItemSummary[], filter: OpenItemsFilter): ItemSummary[] {
  return items.filter(item => !item.dismissed && (filter === 'all' || item.kind === filter))
}

export function dismissedItems(items: readonly ItemSummary[]): ItemSummary[] {
  return items.filter(item => item.dismissed)
}

export function openItemsEmptyLine(filter: OpenItemsFilter): string {
  switch (filter) {
    case 'all': return 'No open pull requests or issues.'
    case 'issue': return 'No open issues.'
    case 'pull_request': return 'No open pull requests.'
  }
}

export function enableWritesConsequence(): string {
  return 'Agents can push branches and write comments on this repository.'
}
