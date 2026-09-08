import { afterEach, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
const earlier = '2026-09-08T00:00:00.000Z'
const later = '2026-09-08T00:01:00.000Z'
const priority = 'harlan-zw/melbjs-clone'

afterEach(() => stores.splice(0).forEach(store => store.close()))

function setup() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  store.syncRepositories([
    repositoryMapping(),
    repositoryMapping({ github: priority, priority: 100 }),
  ], earlier)
  return store
}

it('claims newer priority issues before older background issues', () => {
  const store = setup()
  store.recordObservation({ externalId: 'background', observedAt: earlier, source: 'poll', subject: issueItem() })
  store.recordObservation({ externalId: 'priority', observedAt: later, source: 'poll', subject: issueItem({ repository: priority }) })

  expect(store.claimNextIssueTriageTask('first', later, 60_000)?.repository).toBe(priority)
  expect(store.claimNextIssueTriageTask('second', later, 60_000)?.repository).toBe('harlan-zw/example')
})

it('gives priority issues the next permit before background conflict work', () => {
  const store = setup()
  store.recordObservation({ externalId: 'background', observedAt: earlier, source: 'poll', subject: pullRequestItem() })
  store.recordObservation({ externalId: 'priority', observedAt: later, source: 'poll', subject: issueItem({ repository: priority }) })

  expect(store.claimNextConflictTask('background', later, 60_000)).toBeNull()
  expect(store.claimNextIssueTriageTask('priority', later, 60_000)?.repository).toBe(priority)
  expect(store.claimNextConflictTask('background', later, 60_000)?.repository).toBe('harlan-zw/example')
})

it('lets background work run while a priority repository is paused', () => {
  const store = setup()
  store.recordObservation({ externalId: 'background', observedAt: earlier, source: 'poll', subject: issueItem() })
  store.recordObservation({ externalId: 'priority', observedAt: later, source: 'poll', subject: issueItem({ repository: priority }) })
  store.setRepositoryPaused(priority, true)

  expect(store.claimNextIssueTriageTask('background', later, 60_000)?.repository).toBe('harlan-zw/example')
})
