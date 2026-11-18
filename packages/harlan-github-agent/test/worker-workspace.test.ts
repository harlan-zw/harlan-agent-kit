import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { agentWorktreeBranch, createAgentWorkspaceManager } from '../src/worktree.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const temporaryDirectories: string[] = []

afterEach(() => temporaryDirectories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim()
}

describe('worker workspace', () => {
  it('runs a Routine from its pinned source commit after the default branch advances', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harlan-routine-workspace-'))
    temporaryDirectories.push(root)
    const remote = join(root, 'remote.git')
    const checkout = join(root, 'checkout')
    execFileSync('git', ['init', '--bare', remote])
    execFileSync('git', ['clone', remote, checkout])
    git(checkout, 'config', 'user.email', 'agent@example.com')
    git(checkout, 'config', 'user.name', 'Agent Test')
    execFileSync('touch', [join(checkout, 'routine-source')])
    git(checkout, 'add', 'routine-source')
    git(checkout, 'commit', '-m', 'routine source')
    git(checkout, 'branch', '-M', 'main')
    const sourceSha = git(checkout, 'rev-parse', 'HEAD')
    git(checkout, 'push', 'origin', 'main')
    execFileSync('touch', [join(checkout, 'new-source')])
    git(checkout, 'add', 'new-source')
    git(checkout, 'commit', '-m', 'advance main')
    git(checkout, 'push', 'origin', 'main')

    const manager = createAgentWorkspaceManager({
      remoteUrl: () => remote,
      root: join(root, 'worktrees'),
      tokens: { getToken: () => Promise.resolve(ok({ token: 'test', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })
    const prepared = await manager.prepareRoutine({
      id: 'routine-run',
      routineId: 'harlan-zw/example:pr-triage',
      repository: 'harlan-zw/example',
      repositoryMapping: repositoryMapping({ checkout }),
      name: 'pr-triage',
      mode: 'report',
      scheduledFor: '2026-08-13T09:00:00.000Z',
      specSha: sourceSha,
      attempts: 1,
      state: { _tag: 'Running', fence: 1, workerId: 'routine-1', leaseExpiresAt: '2026-08-13T10:00:00.000Z' },
    }, AbortSignal.timeout(10_000))

    expect(prepared).toMatchObject({ _tag: 'Ok', value: { baseSha: sourceSha, headSha: sourceSha, defaultBranchSha: git(checkout, 'rev-parse', 'main') } })
  })

  it('checks out a published release and resolves an annotated previous tag to its commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harlan-release-note-workspace-'))
    temporaryDirectories.push(root)
    const remote = join(root, 'remote.git')
    const checkout = join(root, 'checkout')
    execFileSync('git', ['init', '--bare', remote])
    execFileSync('git', ['clone', remote, checkout])
    git(checkout, 'config', 'user.email', 'agent@example.com')
    git(checkout, 'config', 'user.name', 'Agent Test')
    execFileSync('touch', [join(checkout, 'first')])
    git(checkout, 'add', 'first')
    git(checkout, 'commit', '-m', 'first release')
    git(checkout, 'branch', '-M', 'main')
    const previousSha = git(checkout, 'rev-parse', 'HEAD')
    git(checkout, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0')
    execFileSync('touch', [join(checkout, 'second')])
    git(checkout, 'add', 'second')
    git(checkout, 'commit', '-m', 'fix: handle input (#2)')
    const releaseSha = git(checkout, 'rev-parse', 'HEAD')
    execFileSync('touch', [join(checkout, 'later')])
    git(checkout, 'add', 'later')
    git(checkout, 'commit', '-m', 'later work')
    git(checkout, 'push', '--follow-tags', 'origin', 'main')

    const manager = createAgentWorkspaceManager({
      remoteUrl: () => remote,
      root: join(root, 'worktrees'),
      tokens: { getToken: () => Promise.resolve(ok({ token: 'test', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })
    const prepared = await manager.prepareReleaseNote({
      id: 'a'.repeat(64),
      repository: 'harlan-zw/example',
      repositoryMapping: repositoryMapping({ checkout }),
      pullRequestNumber: 2,
      packageName: 'example',
      version: '1.0.1',
      tag: 'v1.0.1',
      previousTag: 'v1.0.0',
      sha: releaseSha,
      pullRequests: { _tag: 'Available', entries: [] },
      attempts: 1,
      state: { _tag: 'Running', fence: 1, workerId: 'release-note-1', leaseExpiresAt: '2026-08-13T10:00:00.000Z' },
    }, AbortSignal.timeout(10_000))

    expect(prepared).toMatchObject({ _tag: 'Ok', value: { baseSha: previousSha, headSha: releaseSha } })
    if (prepared._tag === 'Ok')
      expect(git(prepared.value.path, 'log', '--format=%s', `${prepared.value.baseSha}..HEAD`)).toBe('fix: handle input (#2)')
  })

  it('reviews the exact pull request base commit after the default branch advances', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harlan-review-workspace-'))
    temporaryDirectories.push(root)
    const remote = join(root, 'remote.git')
    const checkout = join(root, 'checkout')
    execFileSync('git', ['init', '--bare', remote])
    execFileSync('git', ['clone', remote, checkout])
    git(checkout, 'config', 'user.email', 'agent@example.com')
    git(checkout, 'config', 'user.name', 'Agent Test')
    execFileSync('touch', [join(checkout, 'base')])
    git(checkout, 'add', 'base')
    git(checkout, 'commit', '-m', 'base')
    git(checkout, 'branch', '-M', 'main')
    const baseSha = git(checkout, 'rev-parse', 'HEAD')
    git(checkout, 'switch', '-c', 'fix/review')
    execFileSync('touch', [join(checkout, 'head')])
    git(checkout, 'add', 'head')
    git(checkout, 'commit', '-m', 'head')
    const headSha = git(checkout, 'rev-parse', 'HEAD')
    git(checkout, 'push', 'origin', 'main', 'fix/review')
    git(remote, 'update-ref', 'refs/pull/24/head', headSha)
    git(checkout, 'switch', 'main')
    execFileSync('touch', [join(checkout, 'new-base')])
    git(checkout, 'add', 'new-base')
    git(checkout, 'commit', '-m', 'advance main')
    git(checkout, 'push', 'origin', 'main')

    const store = openJournalStore(':memory:')
    store.syncRepositories([repositoryMapping({ checkout })], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'advanced-base',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ baseSha, headSha, mergeState: 'clean' }),
    })
    const task = store.claimNextAdversarialReviewTask('worker-1', '2026-08-13T01:01:00.000Z', 10_000)
    if (task === null)
      throw new Error('Expected a review task.')
    const manager = createAgentWorkspaceManager({
      remoteUrl: () => remote,
      root: join(root, 'worktrees'),
      tokens: { getToken: () => Promise.resolve(ok({ token: 'test', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })

    const prepared = await manager.prepareReview(task, AbortSignal.timeout(10_000))

    expect(prepared).toEqual(ok({
      path: expect.any(String),
      baseSha,
      headSha,
    }))
    if (prepared._tag === 'Err')
      throw new Error(prepared.error)
    const branch = agentWorktreeBranch(`review-${task.pullRequestNumber}-${task.revisionId.slice(0, 12)}`, { taskId: task.id, fence: task.state.fence })
    expect(prepared.value.path).toBe(join(root, `checkout.${branch.replaceAll('/', '-')}`))
    store.close()
  })
})
