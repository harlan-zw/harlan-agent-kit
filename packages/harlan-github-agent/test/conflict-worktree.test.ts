import type { ClaimedConflictResolutionTask } from '../src/types.ts'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { createConflictWorktreeManager, createGitPublicationRemote } from '../src/worktree.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
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

function fixture(): { currentBaseSha: string, remote: string, root: string, task: ClaimedConflictResolutionTask } {
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
  writeFileSync(join(checkout, 'file.txt'), 'original\n')
  git(checkout, 'add', 'file.txt')
  git(checkout, 'commit', '-m', 'initial')
  git(checkout, 'push', 'origin', 'main')
  const staleBaseSha = git(checkout, 'rev-parse', 'HEAD')

  git(checkout, 'checkout', '-b', 'fix/conflict')
  writeFileSync(join(checkout, 'file.txt'), 'pull request\n')
  git(checkout, 'commit', '-am', 'pull request change')
  const headSha = git(checkout, 'rev-parse', 'HEAD')
  git(checkout, 'push', 'origin', 'HEAD:refs/pull/1/head')

  git(checkout, 'checkout', 'main')
  writeFileSync(join(checkout, 'file.txt'), 'current base\n')
  git(checkout, 'commit', '-am', 'base change')
  git(checkout, 'push', 'origin', 'main')
  const currentBaseSha = git(checkout, 'rev-parse', 'HEAD')
  const mapping = repositoryMapping({ checkout, defaultBranch: 'main' })
  return {
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

describe('conflict worktree', () => {
  it('uses the current base branch when the pull request base SHA is stale', async () => {
    const { currentBaseSha, remote, root, task } = fixture()
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve({ _tag: 'Ok', value: { token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' } }), invalidate: () => undefined },
    })

    const result = await manager.prepare(task, new AbortController().signal)

    expect(result).toEqual(expect.objectContaining({ _tag: 'Ok', value: expect.objectContaining({ baseSha: currentBaseSha, conflictedFiles: ['file.txt'] }) }))
  })

  it('stages a verified conflict file in the controller-owned index', async () => {
    const { remote, root, task } = fixture()
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve({ _tag: 'Ok', value: { token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' } }), invalidate: () => undefined },
    })
    const prepared = await manager.prepare(task, new AbortController().signal)
    if (prepared._tag === 'Err')
      throw new Error(prepared.error)
    writeFileSync(join(prepared.value.path, 'file.txt'), 'resolved\n')

    const verified = await manager.verify(task, prepared.value, new AbortController().signal)

    expect(verified).toEqual(expect.objectContaining({ _tag: 'Ok', value: expect.objectContaining({ changedFiles: 1 }) }))
    expect(git(prepared.value.path, 'diff', '--name-only', '--diff-filter=U')).toBe('')
  })

  it('verifies conflict patches larger than the child process output buffer', async () => {
    const { remote, root, task } = fixture()
    const manager = createConflictWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve({ _tag: 'Ok', value: { token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' } }), invalidate: () => undefined },
    })
    const prepared = await manager.prepare(task, new AbortController().signal)
    if (prepared._tag === 'Err')
      throw new Error(prepared.error)
    writeFileSync(join(prepared.value.path, 'file.txt'), `${'resolved line\n'.repeat(100_000)}`)

    const verified = await manager.verify(task, prepared.value, new AbortController().signal)

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
    const prepared = await manager.prepare(task, new AbortController().signal)
    if (prepared._tag === 'Err')
      throw new Error(prepared.error)
    writeFileSync(join(prepared.value.path, 'file.txt'), 'pull request\n')

    const verified = await manager.verify(task, prepared.value, new AbortController().signal)

    expect(verified).toEqual(expect.objectContaining({ _tag: 'Ok', value: expect.objectContaining({ changedFiles: 0 }) }))
    if (verified._tag === 'Err')
      throw new Error(verified.error)
    const committed = await manager.commit(task, prepared.value, verified.value, 'merge: reconcile parser changes', new AbortController().signal)

    expect(committed).toEqual(expect.objectContaining({ _tag: 'Ok' }))
    expect(git(prepared.value.path, 'show', '--no-patch', '--format=%an <%ae>')).toBe('Harlan Wilton <harlan@harlanzw.com>')
    expect(git(prepared.value.path, 'show', '--no-patch', '--format=%s')).toBe('merge: reconcile parser changes')
  })
  it('publishes a resolution whose digest was read where blob names abbreviate differently', async () => {
    // Git scales blob name abbreviation with the object count of a repository,
    // so the checkout that resolves a conflict and the controller mirror that
    // publishes it disagreed on the same commit and every publication failed.
    const { remote, root, task } = fixture()
    const options = {
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    }
    const manager = createConflictWorktreeManager(options)
    const prepared = await manager.prepare(task, new AbortController().signal)
    if (prepared._tag === 'Err')
      throw new Error(prepared.error)
    git(prepared.value.path, 'config', 'core.abbrev', '20')
    writeFileSync(join(prepared.value.path, 'file.txt'), 'resolved\n')
    const verified = await manager.verify(task, prepared.value, new AbortController().signal)
    if (verified._tag === 'Err')
      throw new Error(verified.error)
    const committed = await manager.commit(task, prepared.value, verified.value, 'merge: resolve conflicts', new AbortController().signal)
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
    expect(git(remote, 'rev-parse', 'refs/heads/fix/conflict')).toBe(committed.value.commitSha)
  })
})
