import type { ClaimedConflictResolutionTask } from '../src/types.ts'
import type { ConflictWorktreeManager, PreparedConflictWorktree } from '../src/worktree.ts'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { createConflictWorker } from '../src/conflict-worker.ts'
import { ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { createConflictWorktreeManager, createGitPublicationRemote } from '../src/worktree.ts'
import { agentRuntime, agentTurnLedger, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

const temporaryDirectories: string[] = []
const stores: ReturnType<typeof openJournalStore>[] = []

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
  temporaryDirectories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
})

function git(checkout: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-C', checkout, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim()
}

function fixture(conflictPath = 'file.txt', extraPath?: string): { checkout: string, currentBaseSha: string, remote: string, root: string, task: ClaimedConflictResolutionTask } {
  const directory = mkdtempSync(join(tmpdir(), 'harlan-conflict-worktree-'))
  temporaryDirectories.push(directory)
  const remote = join(directory, 'remote.git')
  const checkout = join(directory, 'checkout')
  const root = join(directory, 'controller')
  execFileSync('git', ['init', '--bare', remote])
  execFileSync('git', ['clone', remote, checkout])
  git(checkout, 'config', 'user.name', 'Test Agent')
  git(checkout, 'config', 'user.email', 'agent@example.com')
  git(checkout, 'checkout', '-b', 'main')
  writeFileSync(join(checkout, conflictPath), 'original\n')
  if (extraPath !== undefined)
    writeFileSync(join(checkout, extraPath), 'pull request\n')
  // `helper.ts` is what the base branch moves under a resolution. `keep.ts` is
  // what neither side touches, so nothing may edit it.
  writeFileSync(join(checkout, 'helper.ts'), 'export const limit = 1\n')
  writeFileSync(join(checkout, 'keep.ts'), 'export const kept = true\n')
  git(checkout, 'add', '--all')
  git(checkout, 'commit', '-m', 'initial')
  git(checkout, 'push', 'origin', 'main')
  const staleBaseSha = git(checkout, 'rev-parse', 'HEAD')

  git(checkout, 'checkout', '-b', 'fix/conflict')
  writeFileSync(join(checkout, conflictPath), 'pull request\n')
  git(checkout, 'commit', '-am', 'pull request change')
  const headSha = git(checkout, 'rev-parse', 'HEAD')
  git(checkout, 'push', 'origin', 'HEAD:refs/pull/1/head')

  git(checkout, 'checkout', 'main')
  writeFileSync(join(checkout, conflictPath), 'current base\n')
  git(checkout, 'commit', '-am', 'base change')
  git(checkout, 'push', 'origin', 'main')
  const currentBaseSha = git(checkout, 'rev-parse', 'HEAD')
  const mapping = repositoryMapping({ checkout, defaultBranch: 'main' })
  return {
    checkout,
    currentBaseSha,
    remote,
    root,
    task: {
      id: 'task-1',
      kind: 'resolve_conflict',
      repository: mapping.github,
      pullRequestNumber: 1,
      revisionId: 'revision-1',
      updatedAt: '2026-08-13T01:00:00.000Z',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T01:10:00.000Z' },
      repositoryMapping: mapping,
      pullRequest: pullRequestItem({ number: 1, baseSha: staleBaseSha, headSha }),
    },
  }
}

async function conflicted(manager: ConflictWorktreeManager, task: ClaimedConflictResolutionTask): Promise<PreparedConflictWorktree> {
  const prepared = await manager.prepare(task, new AbortController().signal)
  if (prepared._tag === 'Err')
    throw new Error(prepared.error)
  if (prepared.value._tag !== 'Conflicted')
    throw new Error('Expected a conflicted worktree.')
  return prepared.value.worktree
}

describe('conflict worktree', () => {
  it('retries a blocked conflict in a fresh worktree against the actual current base', async () => {
    const { checkout, remote, root, task } = fixture()
    const store = openJournalStore(':memory:', true)
    stores.push(store)
    store.syncRepositories([task.repositoryMapping], '2026-08-13T01:00:00.000Z')
    store.setRepositoryWritesEnabled(task.repository, true)
    const observed = store.recordObservation({ externalId: 'conflict-retry', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject: task.pullRequest })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request.')
    const first = store.claimNextConflictTask('first-agent', '2026-08-13T01:00:01.000Z', 60_000)!
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Test Agent', email: 'agent@example.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })
    const retained = await conflicted(manager, first)
    writeFileSync(join(retained.path, 'file.txt'), 'stale unverified resolution\n')
    store.needsAttentionTask({ taskId: first.id, workerId: first.state.workerId, fence: first.state.fence, at: '2026-08-13T01:00:02.000Z', reason: 'Cargo is unavailable.', evidence: 'Unverified local merge.' })
    writeFileSync(join(checkout, 'file.txt'), 'newest actual base\n')
    git(checkout, 'commit', '-am', 'advance the base again')
    git(checkout, 'push', 'origin', 'main')
    const actualBaseSha = git(checkout, 'rev-parse', 'HEAD')

    expect(store.requestReviewRerun({ repository: task.repository, pullRequestNumber: task.pullRequestNumber, revisionId: observed.revisionId, requestId: 'toolchain-fixed', source: 'dashboard', requestedBy: 'dashboard', at: '2026-08-13T01:00:03.000Z' })).toEqual({ _tag: 'Queued', taskId: first.id })
    const retry = store.claimNextConflictTask('fresh-agent', '2026-08-13T01:00:04.000Z', 60_000)!
    const fresh = await conflicted(manager, retry)

    expect(fresh.path).not.toBe(retained.path)
    expect(fresh.baseSha).toBe(actualBaseSha)
    expect(git(fresh.path, 'rev-parse', 'MERGE_HEAD')).toBe(actualBaseSha)
    expect(readFileSync(join(fresh.path, 'file.txt'), 'utf8')).toContain('newest actual base')
    expect(readFileSync(join(fresh.path, 'file.txt'), 'utf8')).not.toContain('stale unverified resolution')
    expect(readFileSync(join(retained.path, 'file.txt'), 'utf8')).toBe('stale unverified resolution\n')
  })

  it('uses the current base branch when the pull request base SHA is stale', async () => {
    const { currentBaseSha, remote, root, task } = fixture()
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve({ _tag: 'Ok', value: { token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' } }), invalidate: () => undefined },
    })

    const result = await manager.prepare(task, new AbortController().signal)

    expect(result).toEqual(expect.objectContaining({ _tag: 'Ok', value: expect.objectContaining({ _tag: 'Conflicted', worktree: expect.objectContaining({ baseSha: currentBaseSha, conflictedFiles: ['file.txt'] }) }) }))
  })

  it('reports a clean merge instead of a failure when the base merges without conflicts', async () => {
    const { checkout, remote, root, task } = fixture()
    // GitHub kept reporting two stacked pull requests as conflicting while
    // their real base merged cleanly. Prepare read that as a failure, spent
    // the whole recovery budget, and raised an error Incident each time.
    git(checkout, 'checkout', '-b', 'feature/clean', task.pullRequest.baseSha)
    writeFileSync(join(checkout, 'helper.ts'), 'export const limit = 2\n')
    git(checkout, 'commit', '-am', 'raise the limit')
    git(checkout, 'push', 'origin', 'feature/clean')
    const cleanBaseSha = git(checkout, 'rev-parse', 'HEAD')
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })

    const result = await manager.prepare({ ...task, pullRequest: { ...task.pullRequest, baseRef: 'feature/clean' } }, new AbortController().signal)

    expect(result).toEqual(ok({ _tag: 'CleanMerge', headSha: task.pullRequest.headSha, baseSha: cleanBaseSha, baseRef: 'feature/clean' }))
  })

  it('reports the Git error when the merge fails for a reason other than conflicts', async () => {
    const { checkout, remote, root, task } = fixture()
    // A merge that fails before it can conflict has no unmerged files either.
    // That used to read as "no longer conflicts" and hid the real error.
    git(checkout, 'checkout', '--orphan', 'feature/unrelated')
    writeFileSync(join(checkout, 'file.txt'), 'unrelated\n')
    git(checkout, 'add', '--all')
    git(checkout, 'commit', '-m', 'unrelated history')
    git(checkout, 'push', 'origin', 'feature/unrelated')
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })

    const result = await manager.prepare({ ...task, pullRequest: { ...task.pullRequest, baseRef: 'feature/unrelated' } }, new AbortController().signal)

    expect(result).toEqual({ _tag: 'Err', error: expect.stringContaining('refusing to merge unrelated histories') })
  })

  it('merges the stacked base branch instead of the default branch', async () => {
    const { checkout, remote, root, task } = fixture()
    // A stack: the pull request merges into another branch that diverged from
    // main. Merging main here resolves the wrong conflict and the publication
    // base check never matches.
    git(checkout, 'checkout', '-b', 'feature/parent', task.pullRequest.baseSha)
    writeFileSync(join(checkout, 'file.txt'), 'parent base\n')
    git(checkout, 'commit', '-am', 'parent change')
    git(checkout, 'push', 'origin', 'feature/parent')
    const parentSha = git(checkout, 'rev-parse', 'HEAD')
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve({ _tag: 'Ok', value: { token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' } }), invalidate: () => undefined },
    })

    const result = await manager.prepare({ ...task, pullRequest: { ...task.pullRequest, baseRef: 'feature/parent' } }, new AbortController().signal)

    expect(result).toEqual(expect.objectContaining({ _tag: 'Ok', value: expect.objectContaining({ _tag: 'Conflicted', worktree: expect.objectContaining({ baseSha: parentSha, conflictedFiles: ['file.txt'] }) }) }))
    if (result._tag === 'Err' || result.value._tag !== 'Conflicted')
      throw new Error('Expected a conflicted worktree.')
    expect(git(result.value.worktree.path, 'rev-parse', 'MERGE_HEAD')).toBe(parentSha)
  })

  it('stages a verified conflict file in the controller-owned index', async () => {
    const { remote, root, task } = fixture()
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve({ _tag: 'Ok', value: { token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' } }), invalidate: () => undefined },
    })
    const prepared = await conflicted(manager, task)
    writeFileSync(join(prepared.path, 'file.txt'), 'resolved\n')

    const verified = await manager.verify(task, prepared, new AbortController().signal)

    expect(verified).toEqual(expect.objectContaining({ _tag: 'Ok', value: expect.objectContaining({ changedFiles: 1 }) }))
    expect(git(prepared.path, 'diff', '--name-only', '--diff-filter=U')).toBe('')
  })

  it.each([
    ['working tree', 'text'],
    ['index', 'text'],
    ['working tree', 'modify/delete'],
    ['index', 'modify/delete'],
  ] as const)('accepts a conflict deletion from the %s after a %s conflict', async (location, conflict) => {
    const { checkout, remote, root, task } = fixture()
    if (conflict === 'modify/delete') {
      git(checkout, 'rm', '--', 'file.txt')
      git(checkout, 'commit', '-m', 'delete the base file')
      git(checkout, 'push', 'origin', 'main')
    }
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })
    const prepared = await conflicted(manager, task)
    if (location === 'index')
      git(prepared.path, 'rm', '--force', '--', 'file.txt')
    else
      rmSync(join(prepared.path, 'file.txt'))

    const verified = await manager.verify(task, prepared, new AbortController().signal)

    expect(verified).toEqual(expect.objectContaining({ _tag: 'Ok', value: expect.objectContaining({ changedFiles: 1 }) }))
    if (verified._tag === 'Err')
      throw new Error(verified.error)
    const committed = await manager.commit(task, prepared, verified.value, 'fix: resolve by deleting the file', new AbortController().signal)
    expect(committed).toEqual(expect.objectContaining({ _tag: 'Ok' }))
    expect(git(prepared.path, 'ls-tree', '--name-only', 'HEAD')).not.toContain('file.txt')
  })

  it.each(['edit', 'delete', 'reverted edit'] as const)('rejects an unrelated staged %s', async (change) => {
    const { remote, root, task } = fixture()
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })
    const prepared = await conflicted(manager, task)
    writeFileSync(join(prepared.path, 'file.txt'), 'resolved\n')
    prepared.writablePaths.push('keep.ts')
    if (change === 'delete') {
      git(prepared.path, 'rm', '--', 'keep.ts')
    }
    else {
      writeFileSync(join(prepared.path, 'keep.ts'), 'export const kept = false\n')
      git(prepared.path, 'add', '--', 'keep.ts')
      if (change === 'reverted edit')
        writeFileSync(join(prepared.path, 'keep.ts'), 'export const kept = true\n')
    }

    const verified = await manager.verify(task, prepared, new AbortController().signal)

    expect(verified).toEqual({ _tag: 'Err', error: 'The worker changed a file the merge did not touch: keep.ts.' })
  })

  it.each(['\n', ' ', '\t'])('rejects an unrelated path with prefix %j', async (prefix) => {
    const unrelatedPath = `${prefix}file.txt`
    const { remote, root, task } = fixture('file.txt', unrelatedPath)
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Test Agent', email: 'agent@example.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })
    const prepared = await conflicted(manager, task)
    writeFileSync(join(prepared.path, 'file.txt'), 'resolved\n')
    writeFileSync(join(prepared.path, unrelatedPath), 'unauthorized\n')
    git(prepared.path, 'add', '--', unrelatedPath)

    const verified = await manager.verify(task, prepared, new AbortController().signal)

    expect(verified).toEqual({ _tag: 'Err', error: `The worker changed a file the merge did not touch: ${unrelatedPath}.` })
    expect(git(prepared.path, 'rev-parse', 'HEAD')).toBe(task.pullRequest.headSha)
  })

  it('rejects Git path bytes that cannot be decoded without replacement', async () => {
    const { remote, root, task } = fixture('�file.txt')
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Test Agent', email: 'agent@example.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })
    const prepared = await conflicted(manager, task)
    writeFileSync(join(prepared.path, '�file.txt'), 'resolved\n')
    const invalidPath = Buffer.concat([Buffer.from(`${prepared.path}/`), Buffer.from([0xFF]), Buffer.from('file.txt')])
    writeFileSync(invalidPath, 'unauthorized\n')
    git(prepared.path, 'add', '--all')

    const verified = await manager.verify(task, prepared, new AbortController().signal)

    expect(verified).toEqual({ _tag: 'Err', error: 'Could not inspect the conflict fix: Git output contains invalid UTF-8.' })
    expect(git(prepared.path, 'rev-parse', 'HEAD')).toBe(task.pullRequest.headSha)
  })

  it('rejects an index path changed only by trailing whitespace after verification', async () => {
    const { remote, root, task } = fixture('file.txt', 'file.txt ')
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Test Agent', email: 'agent@example.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })
    const prepared = await conflicted(manager, task)
    writeFileSync(join(prepared.path, 'file.txt'), 'resolved\n')
    const verified = await manager.verify(task, prepared, new AbortController().signal)
    if (verified._tag === 'Err')
      throw new Error(verified.error)
    git(prepared.path, 'restore', '--source=HEAD', '--staged', '--', 'file.txt')
    writeFileSync(join(prepared.path, 'file.txt '), 'resolved\n')
    git(prepared.path, 'add', '--', 'file.txt ')

    const committed = await manager.commit(task, prepared, verified.value, 'fix: resolve conflicts', new AbortController().signal)

    expect(committed).toEqual({ _tag: 'Err', error: 'The conflict index changed after verification.' })
    expect(git(prepared.path, 'rev-parse', 'HEAD')).toBe(task.pullRequest.headSha)
  })

  it('commits only the verified index when files change after verification', async () => {
    const { remote, root, task } = fixture()
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })
    const prepared = await conflicted(manager, task)
    writeFileSync(join(prepared.path, 'file.txt'), 'resolved\n')
    const verified = await manager.verify(task, prepared, new AbortController().signal)
    if (verified._tag === 'Err')
      throw new Error(verified.error)
    writeFileSync(join(prepared.path, 'keep.ts'), 'export const kept = false\n')

    const committed = await manager.commit(task, prepared, verified.value, 'fix: resolve conflicts', new AbortController().signal)

    expect(committed).toEqual(expect.objectContaining({ _tag: 'Ok' }))
    expect(git(prepared.path, 'show', 'HEAD:keep.ts')).toBe('export const kept = true')
    expect(git(prepared.path, 'diff', '--name-only')).toBe('keep.ts')
  })

  it('rejects an index changed after verification before creating a commit', async () => {
    const { remote, root, task } = fixture()
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })
    const prepared = await conflicted(manager, task)
    writeFileSync(join(prepared.path, 'file.txt'), 'resolved\n')
    const verified = await manager.verify(task, prepared, new AbortController().signal)
    if (verified._tag === 'Err')
      throw new Error(verified.error)
    writeFileSync(join(prepared.path, 'keep.ts'), 'export const kept = false\n')
    git(prepared.path, 'add', '--', 'keep.ts')

    const committed = await manager.commit(task, prepared, verified.value, 'fix: resolve conflicts', new AbortController().signal)

    expect(committed).toEqual({ _tag: 'Err', error: 'The conflict index changed after verification.' })
    expect(git(prepared.path, 'rev-parse', 'HEAD')).toBe(task.pullRequest.headSha)
    expect(git(prepared.path, 'rev-parse', 'MERGE_HEAD')).toBe(prepared.baseSha)
  })

  it('verifies conflict patches larger than the child process output buffer', async () => {
    const { remote, root, task } = fixture()
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve({ _tag: 'Ok', value: { token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' } }), invalidate: () => undefined },
    })
    const prepared = await conflicted(manager, task)
    writeFileSync(join(prepared.path, 'file.txt'), `${'resolved line\n'.repeat(100_000)}`)

    const verified = await manager.verify(task, prepared, new AbortController().signal)

    expect(verified).toEqual(expect.objectContaining({ _tag: 'Ok', value: expect.objectContaining({ changedFiles: 1 }) }))
  })

  it('permits a merge commit that keeps the pull request file unchanged', async () => {
    const { remote, root, task } = fixture()
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve({ _tag: 'Ok', value: { token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' } }), invalidate: () => undefined },
    })
    const prepared = await conflicted(manager, task)
    writeFileSync(join(prepared.path, 'file.txt'), 'pull request\n')

    const verified = await manager.verify(task, prepared, new AbortController().signal)

    expect(verified).toEqual(expect.objectContaining({ _tag: 'Ok', value: expect.objectContaining({ changedFiles: 0 }) }))
    if (verified._tag === 'Err')
      throw new Error(verified.error)
    const committed = await manager.commit(task, prepared, verified.value, 'merge: reconcile parser changes', new AbortController().signal)

    expect(committed).toEqual(expect.objectContaining({ _tag: 'Ok' }))
    expect(git(prepared.path, 'show', '--no-patch', '--format=%an <%ae>')).toBe('Harlan Wilton <harlan@harlanzw.com>')
    expect(git(prepared.path, 'show', '--no-patch', '--format=%s')).toBe('merge: reconcile parser changes')
  })
  it.each(['file.txt', '\nfile.txt', ' file.txt', '\tfile.txt', 'file.txt ', 'file.txt\t', 'file.txt\n', 'éfile.txt', '\uFEFFfile.txt'])('publishes a resolution with the exact path %j across Git settings', async (conflictPath) => {
    // Git scales blob name abbreviation with the object count of a repository,
    // so the checkout that resolves a conflict and the controller mirror that
    // publishes it disagreed on the same commit and every publication failed.
    const { remote, root, task } = fixture(conflictPath)
    const options = {
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    }
    const manager = createConflictWorktreeManager(options)
    const prepared = await conflicted(manager, task)
    expect(prepared.conflictedFiles).toEqual([conflictPath])
    git(prepared.path, 'config', 'core.abbrev', '20')
    git(prepared.path, 'config', 'core.quotePath', 'false')
    writeFileSync(join(prepared.path, conflictPath), 'resolved\n')
    const verified = await manager.verify(task, prepared, new AbortController().signal)
    if (verified._tag === 'Err')
      throw new Error(verified.error)
    const committed = await manager.commit(task, prepared, verified.value, 'merge: resolve conflicts', new AbortController().signal)
    if (committed._tag === 'Err')
      throw new Error(committed.error)
    git(join(root, 'repositories', `${task.repository.replace('/', '__')}.git`), 'config', 'core.abbrev', '7')

    const publication = createGitPublicationRemote({
      github: {
        getPullRequest: () => Promise.reject(new Error('This publication reads no pull request.')),
        hasOpenPullRequestForBranch: () => Promise.resolve(ok(false)),
        isBranchProtected: () => Promise.resolve(ok(false)),
      },
      ...options,
    })
    const pushed = await publication.push({
      _tag: 'UpdatePullRequest',
      id: 'publication-1',
      taskId: task.id,
      taskKind: 'resolve_conflict',
      repository: task.repository,
      pullRequestNumber: 1,
      commitSha: committed.value.commitSha,
      baseSha: committed.value.baseSha,
      baseRef: 'main',
      expectedHeadSha: task.pullRequest.headSha,
      headRef: 'fix/conflict',
      artifactRef: committed.value.artifactRef,
      patchDigest: committed.value.digest,
      changedFiles: committed.value.changedFiles,
      outcomeUnknown: false,
      workerId: 'publisher-1',
      fence: 1,
      leaseExpiresAt: '2026-08-13T02:00:00.000Z',
      repositoryMapping: task.repositoryMapping,
    }, new AbortController().signal)

    expect(pushed).toEqual(ok(undefined))
    expect(git(remote, 'show', `refs/heads/fix/conflict:${conflictPath}`)).toBe('resolved')
    expect(git(remote, 'rev-parse', 'refs/heads/fix/conflict')).toBe(committed.value.commitSha)
  })
  it('lets a resolution follow the base branch into a file that never conflicted', async () => {
    const { checkout, remote, root, task } = fixture()
    // The base branch moves `helper.ts` under the pull request. Reconciling the
    // conflict means following it, and that file never carried a marker.
    writeFileSync(join(checkout, 'helper.ts'), 'export const limit = 2\n')
    git(checkout, 'commit', '-am', 'raise the limit')
    git(checkout, 'push', 'origin', 'main')
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })
    const prepared = await conflicted(manager, task)
    expect(prepared.conflictedFiles).toEqual(['file.txt'])
    expect(prepared.writablePaths).toEqual(['file.txt', 'helper.ts'])
    writeFileSync(join(prepared.path, 'file.txt'), 'resolved\n')
    writeFileSync(join(prepared.path, 'helper.ts'), 'export const limit = 3\n')

    const verified = await manager.verify(task, prepared, new AbortController().signal)

    expect(verified).toEqual(expect.objectContaining({ _tag: 'Ok', value: expect.objectContaining({ changedFiles: 2 }) }))
    expect(git(prepared.path, 'diff', '--cached', '--name-only', 'HEAD').split('\n').sort()).toEqual(['file.txt', 'helper.ts'])
  })

  describe('whitespace check', () => {
    // A Markdown hard line break ends in two spaces on purpose.
    const hardBreak = '1. **CONSEQUENCE_TITLE** `IMPACT/100`  \nWhy it matters.\n'
    // Git prints raw paths in check output, so the reader must not split on `:` or a leading `+`.
    const markdownPaths = ['review-contract.md', '+review-contract.md', '\nreview-contract.md', 'notes:2: draft.md']

    function conflictManager(remote: string, root: string): ConflictWorktreeManager {
      return createConflictWorktreeManager({
        gitIdentity: { name: 'Test Agent', email: 'agent@example.com' },
        remoteUrl: () => remote,
        root,
        tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
      })
    }

    function commitToBase(checkout: string, path: string, content: string): void {
      writeFileSync(join(checkout, path), content)
      git(checkout, 'add', '--', path)
      git(checkout, 'commit', '-m', 'base change')
      git(checkout, 'push', 'origin', 'main')
    }

    it.each(markdownPaths)('accepts a hard line break the base branch added to %j', async (path) => {
      // The check compared the merge with the pull request head alone, so it
      // flagged every line main brought in and threw a correct resolution away.
      const { checkout, remote, root, task } = fixture()
      commitToBase(checkout, path, hardBreak)
      const manager = conflictManager(remote, root)
      const prepared = await conflicted(manager, task)
      writeFileSync(join(prepared.path, 'file.txt'), 'resolved\n')

      const verified = await manager.verify(task, prepared, new AbortController().signal)

      expect(verified).toEqual(expect.objectContaining({ _tag: 'Ok', value: expect.objectContaining({ changedFiles: 2 }) }))
    })

    it.each(markdownPaths)('rejects only the trailing whitespace the resolution adds beside %j', async (path) => {
      const { checkout, remote, root, task } = fixture()
      commitToBase(checkout, path, hardBreak)
      const manager = conflictManager(remote, root)
      const prepared = await conflicted(manager, task)
      writeFileSync(join(prepared.path, 'file.txt'), 'resolved  \n')

      const verified = await manager.verify(task, prepared, new AbortController().signal)

      expect(verified).toEqual({ _tag: 'Err', error: 'Resolved patch failed git diff check: file.txt:1: trailing whitespace.\n+resolved  \n' })
    })

    it.each(['base', 'pull request'] as const)('accepts a hard line break the %s side carries into the conflicted file', async (side) => {
      const { checkout, remote, root, task } = fixture()
      let current = task
      if (side === 'base') {
        commitToBase(checkout, 'file.txt', 'current base  \n')
      }
      else {
        git(checkout, 'checkout', 'fix/conflict')
        writeFileSync(join(checkout, 'file.txt'), 'pull request  \n')
        git(checkout, 'commit', '-am', 'pull request hard break')
        git(checkout, 'push', 'origin', 'HEAD:refs/pull/1/head')
        current = { ...task, pullRequest: { ...task.pullRequest, headSha: git(checkout, 'rev-parse', 'HEAD') } }
      }
      const manager = conflictManager(remote, root)
      const prepared = await conflicted(manager, current)
      writeFileSync(join(prepared.path, 'file.txt'), side === 'base' ? 'pull request\ncurrent base  \n' : 'pull request  \ncurrent base\n')

      const verified = await manager.verify(current, prepared, new AbortController().signal)

      expect(verified).toEqual(expect.objectContaining({ _tag: 'Ok' }))
    })

    it('rejects conflict markers left in the resolution', async () => {
      const { checkout, remote, root, task } = fixture()
      commitToBase(checkout, 'review-contract.md', hardBreak)
      const manager = conflictManager(remote, root)
      const prepared = await conflicted(manager, task)

      const verified = await manager.verify(task, prepared, new AbortController().signal)

      expect(verified).toEqual({
        _tag: 'Err',
        error: 'Resolved patch failed git diff check: file.txt:1: leftover conflict marker\nfile.txt:3: leftover conflict marker\nfile.txt:5: leftover conflict marker\n',
      })
    })
  })

  it('refuses a resolution that edits a file the merge never touched', async () => {
    const { remote, root, task } = fixture()
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })
    const prepared = await conflicted(manager, task)
    writeFileSync(join(prepared.path, 'file.txt'), 'resolved\n')
    writeFileSync(join(prepared.path, 'keep.ts'), 'export const kept = false\n')

    const verified = await manager.verify(task, prepared, new AbortController().signal)

    expect(verified).toEqual({ _tag: 'Err', error: 'The worker changed a file the merge did not touch: keep.ts.' })
  })
})

describe('conflict worker against a real merge', () => {
  it('does not publish a merge with a failing check while conflict markers remain', async () => {
    const { remote, root, task } = fixture()
    let commits = 0
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Test Agent', email: 'agent@example.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })
    // The Agent claims a resolved merge but never edits file.txt, so Git's markers stay in it.
    const worker = createConflictWorker({
      github: { getPullRequest: () => Promise.resolve(ok(task.pullRequest)), isBranchProtected: () => Promise.resolve(ok(false)) },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        outcome: 'resolved_with_failures',
        summary: 'Merged. keep.ts still fails its test.',
        checks: [{ command: 'pnpm vitest run keep.test.ts', outcome: 'failed', details: 'keep.ts exports the old value.' }],
        commitMessage: 'merge: keep both changes',
        unavailableCheck: { command: '', error: '' },
        failures: [{ command: 'pnpm vitest run keep.test.ts', paths: ['keep.ts'] }],
      }))),
      store: { getWorkerSession: () => null, saveWorkerSession: () => undefined, ...agentTurnLedger, updateAgentProgress: () => true },
      validateMapping: mapping => Promise.resolve(ok(mapping)),
      worktrees: { ...manager, commit: (...args) => {
        commits += 1
        return manager.commit(...args)
      } },
    })

    const result = await worker.run(task, new AbortController().signal)

    expect(result).toEqual({ _tag: 'Err', error: expect.stringContaining('file.txt:1: leftover conflict marker') })
    expect(commits).toBe(0)
  })
})
