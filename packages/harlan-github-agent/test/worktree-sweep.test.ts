import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { agentWorktreeBranch, agentWorktreeLeaseKey, releaseAgentWorktree, sweepAgentWorktrees } from '../src/worktree.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const temporaryDirectories: string[] = []
const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
  temporaryDirectories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
})

function git(checkout: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-C', checkout, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

/** Stands in for the service, so Worktrunk hooks read the same caller it does. */
function wt(checkout: string, ...args: string[]): string {
  return execFileSync('wt', ['-C', checkout, ...args], {
    encoding: 'utf8',
    env: { HOME: process.env.HOME, PATH: process.env.PATH, HARLAN_GITHUB_AGENT: '1' },
  }).trim()
}

/** One checkout with `main` and one commit, ready for wt worktrees. */
function createCheckout(): { checkout: string, baseSha: string } {
  const directory = mkdtempSync(join(tmpdir(), 'harlan-worktree-sweep-'))
  temporaryDirectories.push(directory)
  const checkout = join(directory, 'checkout')
  execFileSync('git', ['init', '-q', '-b', 'main', checkout])
  git(checkout, 'config', 'user.name', 'Test Author')
  git(checkout, 'config', 'user.email', 'author@example.com')
  writeFileSync(join(checkout, 'file.ts'), 'export const value = 1\n')
  writeFileSync(join(checkout, '.gitignore'), 'node_modules\n')
  git(checkout, 'add', '--all')
  git(checkout, 'commit', '-m', 'initial')
  return { checkout, baseSha: git(checkout, 'rev-parse', 'HEAD') }
}

function branches(checkout: string): string[] {
  const listed: unknown = JSON.parse(wt(checkout, '--config-set', 'list.json-schema=2', 'list', '--format=json'))
  if (typeof listed !== 'object' || listed === null || !('items' in listed) || !Array.isArray(listed.items))
    throw new Error('Expected Worktrunk list schema 2.')
  return listed.items.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('branch' in entry) || typeof entry.branch !== 'string')
      return []
    return [entry.branch]
  }).sort()
}

describe('agent worktree branch', () => {
  it('gives one lease its own branch, so a fenced out lease never shares a worktree', () => {
    const label = 'review-24-abcdef012345'
    const first = agentWorktreeBranch(label, { taskId: 'a'.repeat(64), fence: 1 })
    const second = agentWorktreeBranch(label, { taskId: 'a'.repeat(64), fence: 2 })

    expect(first).not.toBe(second)
    expect(first.startsWith('harlan-agent/')).toBe(true)
    expect(first.endsWith(agentWorktreeLeaseKey({ taskId: 'a'.repeat(64), fence: 1 }))).toBe(true)
  })
})

describe('agent worktree sweep', () => {
  it('removes a worktree no live lease uses and keeps the live one', async () => {
    const { checkout, baseSha } = createCheckout()
    const live = agentWorktreeBranch('review-24-abcdef012345', { taskId: 'a'.repeat(64), fence: 2 })
    const abandoned = agentWorktreeBranch('review-24-abcdef012345', { taskId: 'a'.repeat(64), fence: 1 })
    wt(checkout, 'switch', '--create', abandoned, '--base', baseSha, '--yes')
    wt(checkout, 'switch', '--create', live, '--base', baseSha, '--yes')

    const swept = await sweepAgentWorktrees({
      checkout,
      readLiveLeaseKeys: () => new Set([agentWorktreeLeaseKey({ taskId: 'a'.repeat(64), fence: 2 })]),
    }, new AbortController().signal)

    expect(swept).toEqual({ _tag: 'Ok', value: { removed: [abandoned], failures: [] } })
    expect(branches(checkout)).toEqual(['main', live].sort())
  })

  it('removes a worktree holding agent edits and ignored build output', async () => {
    const { checkout, baseSha } = createCheckout()
    const abandoned = agentWorktreeBranch('issue-12-abcdef012345', { taskId: 'b'.repeat(64), fence: 1 })
    wt(checkout, 'switch', '--create', abandoned, '--base', baseSha, '--yes')
    const worktreePath = `${checkout}.${abandoned.replaceAll('/', '-').replaceAll('.', '-')}`
    writeFileSync(join(worktreePath, 'file.ts'), 'export const value = 2\n')
    writeFileSync(join(worktreePath, 'scratch.txt'), 'agent scratch\n')
    mkdirSync(join(worktreePath, 'node_modules'))
    writeFileSync(join(worktreePath, 'node_modules', 'installed.js'), 'module.exports = 1\n')

    const swept = await sweepAgentWorktrees({
      checkout,
      readLiveLeaseKeys: () => new Set<string>(),
    }, new AbortController().signal)

    expect(swept).toEqual({ _tag: 'Ok', value: { removed: [abandoned], failures: [] } })
    expect(branches(checkout)).toEqual(['main'])
  })

  it('removes a legacy worktree whose branch carries no lease key', async () => {
    const { checkout, baseSha } = createCheckout()
    const legacy = 'harlan-agent/baseline-45c3c456afae-12'
    wt(checkout, 'switch', '--create', legacy, '--base', baseSha, '--yes')

    const swept = await sweepAgentWorktrees({
      checkout,
      readLiveLeaseKeys: () => new Set<string>(),
    }, new AbortController().signal)

    expect(swept).toEqual({ _tag: 'Ok', value: { removed: [legacy], failures: [] } })
    expect(branches(checkout)).toEqual(['main'])
  })

  it('never removes a branch outside the agent namespace', async () => {
    const { checkout, baseSha } = createCheckout()
    wt(checkout, 'switch', '--create', 'feat/harlan-work', '--base', baseSha, '--yes')

    const swept = await sweepAgentWorktrees({
      checkout,
      readLiveLeaseKeys: () => new Set<string>(),
    }, new AbortController().signal)

    expect(swept).toEqual({ _tag: 'Ok', value: { removed: [], failures: [] } })
    expect(branches(checkout)).toEqual(['feat/harlan-work', 'main'])
  })

  it('refuses to release a branch outside the agent namespace', async () => {
    const { checkout, baseSha } = createCheckout()
    wt(checkout, 'switch', '--create', 'feat/harlan-work', '--base', baseSha, '--yes')

    const released = await releaseAgentWorktree(checkout, 'feat/harlan-work', new AbortController().signal)

    expect(released).toEqual({ _tag: 'Err', error: 'The branch is outside the agent worktree namespace.' })
    expect(branches(checkout)).toEqual(['feat/harlan-work', 'main'])
  })

  it('reports an absent worktree instead of failing', async () => {
    const { checkout } = createCheckout()

    const released = await releaseAgentWorktree(checkout, 'harlan-agent/gone-000000000000', new AbortController().signal)

    expect(released).toEqual({ _tag: 'Ok', value: 'Absent' })
  })
})

describe('active task leases', () => {
  it('keeps a Running Routine worktree live', () => {
    const store = openJournalStore(':memory:')
    stores.push(store)
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const [routine] = store.syncRoutines({
      repository: 'harlan-zw/example',
      specSha: 'abc123',
      entries: [{ name: 'pr-triage', crons: ['0 9 * * *'], timeZone: 'UTC', mode: 'report', enabled: true }],
      at: '2026-08-13T00:01:00.000Z',
    })
    if (routine === undefined)
      throw new Error('Expected a stored Routine.')
    store.openRoutineRun({ routineId: routine.id, scheduledFor: '2026-08-13T09:00:00.000Z', specSha: routine.specSha, at: '2026-08-13T09:00:01.000Z' })
    const claimed = store.claimNextRoutineRun('routine-1', '2026-08-13T09:00:02.000Z', 60_000)
    if (claimed === null)
      throw new Error('Expected a claimed Routine run.')

    expect(store.listActiveTaskLeases()).toContainEqual({ taskId: claimed.id, fence: claimed.state.fence })
  })

  it('keeps a queued task live, so a sweep never takes the worktree it will claim', () => {
    const store = openJournalStore(':memory:')
    stores.push(store)
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'sweep-queued',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })

    expect(store.listActiveTaskLeases()).toHaveLength(1)
  })

  it('keeps a claimed task live and drops it once the task completes', () => {
    const store = openJournalStore(':memory:')
    stores.push(store)
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'sweep-1',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    const claimed = store.claimNextConflictTask('worker-1', '2026-08-13T01:00:01.000Z', 60_000)
    if (claimed === null)
      throw new Error('The store queued no conflict resolution task.')

    expect(store.listActiveTaskLeases()).toContainEqual({ taskId: claimed.id, fence: claimed.state.fence })

    store.completeTask({
      taskId: claimed.id,
      workerId: 'worker-1',
      fence: claimed.state.fence,
      at: '2026-08-13T01:00:30.000Z',
      evidence: 'done',
    })

    expect(store.listActiveTaskLeases()).not.toContainEqual({ taskId: claimed.id, fence: claimed.state.fence })
  })
})
