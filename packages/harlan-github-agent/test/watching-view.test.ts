import type { RepositoryStatus } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import {
  filterRepositories,
  openItemsFilter,
  repositoriesEmpty,
  repositoryActions,
  repositoryFlags,
} from '../dashboard/app/utils/watching.ts'
import { issueItem, pullRequestItem } from './fixtures.ts'

function repository(overrides: Partial<RepositoryStatus> = {}): RepositoryStatus {
  return {
    github: 'harlan-zw/nuxt-seo',
    enabled: true,
    writesEnabled: true,
    ownership: 'owned',
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    paused: false,
    subjectCount: 0,
    ...overrides,
  }
}

describe('filterRepositories', () => {
  const list = [repository({ github: 'harlan-zw/nuxt-seo' }), repository({ github: 'unjs/unhead' })]

  it('matches any part of the name without regard to case or padding', () => {
    expect(filterRepositories(list, '  UNHEAD ').map(entry => entry.github)).toEqual(['unjs/unhead'])
  })

  it('keeps every repository for a blank filter', () => {
    expect(filterRepositories(list, '   ')).toHaveLength(2)
  })
})

describe('repositoriesEmpty', () => {
  it('names a filter that hides every repository, and nothing when rows remain', () => {
    expect(repositoriesEmpty(2, 'zzz')).toEqual({ _tag: 'Filtered', text: 'zzz' })
    expect(repositoriesEmpty(2, '')).toBeUndefined()
  })

  it('reports no mappings before it reports a filter', () => {
    expect(repositoriesEmpty(0, 'zzz')).toEqual({ _tag: 'None' })
  })
})

describe('repositoryFlags', () => {
  it('flags nothing on a healthy running repository with writes on', () => {
    expect(repositoryFlags(repository({ lastSuccessAt: '2026-08-14T11:00:00.000Z' }))).toEqual([])
  })

  it('ranks an error above a missing first poll and lists paused and writes off after it', () => {
    expect(repositoryFlags(repository({ lastError: 'boom', paused: true, writesEnabled: false })).map(flag => flag.label)).toEqual(['Action required', 'Paused', 'Writes off'])
    expect(repositoryFlags(repository()).map(flag => flag.label)).toEqual(['Starting'])
  })

  it('never flags writes off on an external watch', () => {
    expect(repositoryFlags(repository({ ownership: 'external', writesEnabled: false, lastSuccessAt: '2026-08-14T11:00:00.000Z' }))).toEqual([])
  })
})

describe('repositoryActions', () => {
  it('offers Pause and Disable writes to a running owned repository with writes on', () => {
    expect(repositoryActions(repository()).map(action => action._tag)).toEqual(['Pause', 'DisableWrites'])
  })

  it('offers Resume and Enable writes once paused with writes off', () => {
    expect(repositoryActions(repository({ paused: true, writesEnabled: false })).map(action => action._tag)).toEqual(['Resume', 'EnableWrites'])
  })

  it('never offers a writes change on an external watch', () => {
    const external = repository({ ownership: 'external', writesEnabled: false })
    expect(repositoryActions(external).map(action => action._tag)).toEqual(['Pause'])
  })
})

describe('openItemsFilter', () => {
  const open = { revisionId: 'a'.repeat(64), observedAt: '2026-08-13T00:00:00.000Z', dismissed: false }
  const items = [
    { ...pullRequestItem({ number: 1 }), ...open, approval: { _tag: 'NotRequired' as const } },
    { ...issueItem({ number: 2 }), ...open },
    { ...issueItem({ number: 3 }), ...open, dismissed: true },
  ]

  it('keeps only issues under the Issues filter and never a dismissed one', () => {
    expect(openItemsFilter(items, 'issue').map(item => item.number)).toEqual([2])
  })

  it('drops dismissed items from All', () => {
    expect(openItemsFilter(items, 'all').map(item => item.number)).toEqual([1, 2])
  })
})
