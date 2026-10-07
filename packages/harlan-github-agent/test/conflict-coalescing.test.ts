import type { GitHubPullRequestItem } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
const directories: string[] = []
const at = (seconds: number) => new Date(Date.parse('2026-10-07T00:00:00.000Z') + seconds * 1000).toISOString()

function setup(path = ':memory:') {
  const store = openJournalStore(path)
  stores.push(store)
  store.syncRepositories([repositoryMapping({ pullRequestReview: false })], at(0))
  return store
}

function observe(store: ReturnType<typeof openJournalStore>, seconds: number, overrides: Partial<GitHubPullRequestItem> = {}) {
  return store.recordObservation({ externalId: `coalesce:${seconds}:${overrides.repository ?? 'default'}`, observedAt: at(seconds), source: 'poll', subject: pullRequestItem(overrides) })
}

const claim = (store: ReturnType<typeof openJournalStore>, seconds: number) => store.claimNextConflictTask('agent', at(seconds), 60_000)

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
})

describe('base movement conflict dispatch', () => {
  it('starts the first conflict immediately', () => {
    const store = setup()
    observe(store, 0)
    expect(claim(store, 0)?.pullRequest.baseSha).toBe('base123')
  })

  it('coalesces rapid base movement and starts only the newest pinned inputs', () => {
    const store = setup()
    observe(store, 0)
    const running = claim(store, 0)
    observe(store, 10, { baseSha: 'base2' })
    expect(claim(store, 11)).toBeNull()
    observe(store, 70, { baseSha: 'base3' })
    expect(claim(store, 130)).toBeNull()
    expect(claim(store, 190)?.pullRequest.baseSha).toBe('base3')
    expect(store.heartbeatTask({ taskId: running!.id, workerId: running!.state.workerId, fence: running!.state.fence, at: at(191), leaseMilliseconds: 60_000 })).toBe(false)
  })

  it('retains the quiet deadline after the controller restarts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'conflict-coalescing-'))
    directories.push(directory)
    const path = join(directory, 'journal.sqlite')
    const first = setup(path)
    observe(first, 0)
    observe(first, 10, { baseSha: 'base2' })
    stores.splice(stores.indexOf(first), 1)
    first.close()
    const resumed = setup(path)
    expect(claim(resumed, 129)).toBeNull()
    expect(claim(resumed, 130)?.pullRequest.baseSha).toBe('base2')
  })

  it('caps a continuous burst so moving bases cannot starve dispatch', () => {
    const store = setup()
    observe(store, 0)
    observe(store, 10, { baseSha: 'base2' })
    observe(store, 110, { baseSha: 'base3' })
    observe(store, 210, { baseSha: 'base4' })
    observe(store, 309, { baseSha: 'base5' })
    expect(claim(store, 309)).toBeNull()
    expect(claim(store, 310)?.pullRequest.baseSha).toBe('base5')
  })

  it('does not reserve priority while a conflict waits for stable inputs', () => {
    const store = setup()
    observe(store, 0)
    observe(store, 10, { baseSha: 'base2' })
    store.syncRepositories([repositoryMapping({ pullRequestReview: false, priority: 1 })], at(11))
    expect(store.hasPriorityAgentTask(at(11))).toBe(false)
    expect(store.hasPriorityAgentTask(at(130))).toBe(true)
  })

  it('allows an independent lower priority conflict to run during the quiet window', () => {
    const store = setup()
    store.syncRepositories([
      repositoryMapping({ pullRequestReview: false, priority: 10 }),
      repositoryMapping({ github: 'harlan-zw/other', pullRequestReview: false, priority: 0 }),
    ], at(0))
    observe(store, 0)
    observe(store, 10, { baseSha: 'base2' })
    observe(store, 11, { repository: 'harlan-zw/other', headRepository: 'harlan-zw/other' })
    expect(claim(store, 11)?.repository).toBe('harlan-zw/other')
  })

  it('does not delay metadata-only changes or reset an existing deadline', () => {
    const store = setup()
    observe(store, 0)
    observe(store, 1, { title: 'Renamed title' })
    expect(claim(store, 1)?.pullRequest.title).toBe('Renamed title')
    observe(store, 10, { title: 'Renamed title', baseSha: 'base2' })
    observe(store, 100, { title: 'Another title', baseSha: 'base2' })
    expect(claim(store, 130)?.pullRequest.title).toBe('Another title')
  })

  it.each([
    { headSha: 'new-head', baseSha: 'base2' },
    { baseRef: 'feature/parent', baseSha: 'new-parent' },
  ])('starts contributor or target changes without the old quiet window: %j', (change) => {
    const store = setup()
    observe(store, 0)
    observe(store, 10, { baseSha: 'base2' })
    observe(store, 11, change)
    expect(claim(store, 11)?.pullRequest).toMatchObject(change)
  })

  it('keeps cancelled Tasks stopped and starts a fresh contributor head immediately', () => {
    const store = setup()
    observe(store, 0)
    observe(store, 10, { baseSha: 'base2' })
    const task = store.getDashboardSnapshot(at(11)).tasks.find(task => task.kind === 'resolve_conflict' && task.state._tag === 'Queued')!
    expect(store.cancelTask({ taskId: task.id, at: at(11) })._tag).toBe('Cancelled')
    observe(store, 12, { baseSha: 'base2' })
    expect(claim(store, 200)).toBeNull()
    observe(store, 201, { baseSha: 'base3', headSha: 'new-head' })
    expect(claim(store, 201)?.pullRequest.headSha).toBe('new-head')
  })
})
