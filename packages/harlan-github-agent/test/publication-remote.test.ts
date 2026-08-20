import type { ClaimedPublicationCommand } from '../src/types.ts'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { createGitPublicationRemote } from '../src/worktree.ts'
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

function fixture(): { bare: string, checkout: string, command: Extract<ClaimedPublicationCommand, { _tag: 'UpdatePullRequest' }>, expectedHeadSha: string, root: string } {
  const root = mkdtempSync(join(tmpdir(), 'harlan-publication-'))
  temporaryDirectories.push(root)
  const bare = join(root, 'remote.git')
  const checkout = join(root, 'checkout')
  execFileSync('git', ['init', '--bare', bare])
  execFileSync('git', ['clone', bare, checkout])
  git(checkout, 'config', 'user.name', 'Test Agent')
  git(checkout, 'config', 'user.email', 'agent@example.com')
  git(checkout, 'checkout', '-b', 'fix/conflict')
  writeFileSync(join(checkout, 'file.txt'), 'base\n')
  git(checkout, 'add', 'file.txt')
  git(checkout, 'commit', '-m', 'base')
  git(checkout, 'push', 'origin', 'fix/conflict')
  const expectedHeadSha = git(checkout, 'rev-parse', 'HEAD')
  git(checkout, 'checkout', '-b', 'main')
  writeFileSync(join(checkout, 'base.txt'), 'base change\n')
  git(checkout, 'add', 'base.txt')
  git(checkout, 'commit', '-m', 'base change')
  const baseSha = git(checkout, 'rev-parse', 'HEAD')
  git(checkout, 'push', 'origin', 'main')
  git(checkout, 'checkout', 'fix/conflict')
  git(checkout, 'merge', '--no-ff', 'main', '-m', 'chore: resolve merge conflicts')
  const commitSha = git(checkout, 'rev-parse', 'HEAD')
  const artifactRef = 'refs/harlan-github-agent/publications/task-1'
  const controller = join(root, 'repositories', 'harlan-zw__example.git')
  mkdirSync(join(root, 'repositories'))
  execFileSync('git', ['clone', '--bare', checkout, controller])
  git(controller, 'update-ref', artifactRef, commitSha)
  const patchDigest = createHash('sha256').update(git(controller, 'diff', '--binary', expectedHeadSha, commitSha)).digest('hex')
  return {
    bare,
    checkout,
    expectedHeadSha,
    root,
    command: {
      _tag: 'UpdatePullRequest',
      id: 'publication-1',
      taskId: 'task-1',
      taskKind: 'resolve_conflict',
      repository: 'harlan-zw/example',
      pullRequestNumber: 1,
      commitSha,
      baseSha,
      baseRef: 'main',
      expectedHeadSha,
      headRef: 'fix/conflict',
      artifactRef,
      patchDigest,
      changedFiles: 1,
      outcomeUnknown: false,
      workerId: 'publisher-1',
      fence: 1,
      leaseExpiresAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: repositoryMapping({ checkout }),
    },
  }
}

describe('git publication remote', () => {
  it('pins the stack base branch, not the default branch', async () => {
    const { bare, command, expectedHeadSha, root } = fixture()
    const stacked: Extract<ClaimedPublicationCommand, { _tag: 'OpenPullRequest' }> = {
      ...command,
      _tag: 'OpenPullRequest',
      taskKind: 'issue_work',
      issueNumber: 30,
      headRef: 'fix/issue-30',
      // The tip of `fix/conflict`, which this pull request stacks on.
      baseRef: 'fix/conflict',
      baseSha: expectedHeadSha,
      pullRequestTitle: 'fix: broken thing',
      pullRequestBody: 'Closes #30.',
    }
    const remote = createGitPublicationRemote({
      github: {
        getPullRequest: () => Promise.reject(new Error('An OpenPullRequest reads no pull request by number.')),
        hasOpenPullRequestForBranch: () => Promise.resolve(ok(false)),
        isBranchProtected: () => Promise.resolve(ok(false)),
      },
      remoteUrl: () => bare,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })

    expect(await remote.validateAuthority(stacked, new AbortController().signal)).toEqual(ok(undefined))
    // The same commit is not the default branch tip, so the default branch cannot stand in for it.
    expect(await remote.validateAuthority({ ...stacked, baseRef: 'main' }, new AbortController().signal))
      .toEqual({ _tag: 'Err', error: 'The base branch changed before publication.' })
  })

  it('refuses to rewrite a branch that already has an open pull request', async () => {
    const { bare, command, root } = fixture()
    const open: Extract<ClaimedPublicationCommand, { _tag: 'OpenPullRequest' }> = {
      ...command,
      _tag: 'OpenPullRequest',
      taskKind: 'baseline_repair',
      pullRequestTitle: 'fix(ci): repair the default branch',
      pullRequestBody: 'Repairs default branch CI.',
    }
    const remote = createGitPublicationRemote({
      github: {
        getPullRequest: () => Promise.reject(new Error('An OpenPullRequest reads no pull request by number.')),
        hasOpenPullRequestForBranch: () => Promise.resolve(ok(true)),
        isBranchProtected: () => Promise.resolve(ok(false)),
      },
      remoteUrl: () => bare,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })

    expect(await remote.validateAuthority(open, new AbortController().signal))
      .toEqual({ _tag: 'Err', error: 'An open pull request already uses this branch.' })
  })

  it('replaces its own leftover branch when it opens a pull request', async () => {
    const { bare, checkout, command, root } = fixture()
    const controller = join(root, 'repositories', 'harlan-zw__example.git')
    git(checkout, 'checkout', 'main')
    writeFileSync(join(checkout, 'stale.txt'), 'stale\n')
    git(checkout, 'add', 'stale.txt')
    git(checkout, 'commit', '-m', 'stale attempt')
    // A branch left behind by an attempt that never opened a pull request.
    const staleSha = git(checkout, 'rev-parse', 'HEAD')
    git(checkout, 'push', 'origin', `${staleSha}:refs/heads/fix/baseline-ci`)
    expect(git(bare, 'rev-parse', 'refs/heads/fix/baseline-ci')).toBe(staleSha)
    git(checkout, 'reset', '--hard', command.baseSha)
    writeFileSync(join(checkout, 'repair.txt'), 'repair\n')
    git(checkout, 'add', 'repair.txt')
    git(checkout, 'commit', '-m', 'fix(ci): repair the default branch')
    const repairSha = git(checkout, 'rev-parse', 'HEAD')
    git(controller, 'fetch', checkout, '+refs/heads/*:refs/remotes/checkout/*')
    const artifactRef = 'refs/harlan-github-agent/publications/baseline'
    git(controller, 'update-ref', artifactRef, repairSha)
    const open: Extract<ClaimedPublicationCommand, { _tag: 'OpenPullRequest' }> = {
      ...command,
      _tag: 'OpenPullRequest',
      taskKind: 'baseline_repair',
      pullRequestTitle: 'fix(ci): repair the default branch',
      pullRequestBody: 'Repairs default branch CI.',
      commitSha: repairSha,
      expectedHeadSha: command.baseSha,
      headRef: 'fix/baseline-ci',
      artifactRef,
      patchDigest: createHash('sha256').update(git(controller, 'diff', '--binary', command.baseSha, repairSha)).digest('hex'),
      changedFiles: 1,
    }
    const remote = createGitPublicationRemote({
      github: {
        getPullRequest: () => Promise.reject(new Error('An OpenPullRequest reads no pull request by number.')),
        hasOpenPullRequestForBranch: () => Promise.resolve(ok(false)),
        isBranchProtected: () => Promise.resolve(ok(false)),
      },
      remoteUrl: () => bare,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })

    expect(await remote.push(open, new AbortController().signal)).toEqual(ok(undefined))
    expect(git(bare, 'rev-parse', 'refs/heads/fix/baseline-ci')).toBe(repairSha)
  })

  it('authorizes an approved repair while the pull request remains clean', async () => {
    const { bare, command, root } = fixture()
    const repair = {
      ...command,
      repositoryMapping: { ...command.repositoryMapping, ownership: 'maintained' as const },
      taskKind: 'review_fix' as const,
    }
    const remote = createGitPublicationRemote({
      github: {
        getPullRequest: () => Promise.resolve(ok(pullRequestItem({
          repository: repair.repository,
          number: 1,
          baseSha: repair.baseSha,
          headSha: repair.expectedHeadSha,
          headRepository: repair.repository,
          headRef: repair.headRef,
          mergeState: 'clean',
        }))),
        hasOpenPullRequestForBranch: () => Promise.resolve(ok(false)),
        isBranchProtected: () => Promise.resolve(ok(false)),
      },
      remoteUrl: () => bare,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })

    expect(await remote.validateAuthority(repair, new AbortController().signal)).toEqual(ok(undefined))
  })

  it('publishes an approved repair to a modifiable contributor branch', async () => {
    const { bare, command, root } = fixture()
    const headRepository = 'contributor/example'
    const repair = { ...command, taskKind: 'review_fix' as const, headRepository }
    const remotes: string[] = []
    const remote = createGitPublicationRemote({
      github: {
        getPullRequest: () => Promise.resolve(ok({
          ...pullRequestItem({
            author: 'contributor',
            repository: repair.repository,
            number: 1,
            baseSha: repair.baseSha,
            headSha: repair.expectedHeadSha,
            headRepository,
            headRef: repair.headRef,
            mergeState: 'clean',
          }),
          maintainerCanModify: true,
        })),
        hasOpenPullRequestForBranch: () => Promise.resolve(ok(false)),
        isBranchProtected: () => Promise.reject(new Error('External branch protection is enforced by GitHub.')),
      },
      remoteUrl: (repository) => {
        remotes.push(repository)
        return bare
      },
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })
    const signal = new AbortController().signal

    expect(await remote.validateAuthority(repair, signal)).toEqual(ok(undefined))
    expect(await remote.getHeadSha(repair, signal)).toEqual(ok(repair.expectedHeadSha))
    expect(remotes).toContain(headRepository)
  })

  it('publishes conflict resolution to a modifiable contributor branch', async () => {
    const { bare, command, root } = fixture()
    const headRepository = 'contributor/example'
    const conflict = { ...command, headRepository }
    const remotes: string[] = []
    const remote = createGitPublicationRemote({
      github: {
        getPullRequest: () => Promise.resolve(ok({
          ...pullRequestItem({
            author: 'contributor',
            repository: conflict.repository,
            number: 1,
            baseSha: conflict.baseSha,
            headSha: conflict.expectedHeadSha,
            headRepository,
            headRef: conflict.headRef,
            mergeState: 'conflicting',
          }),
          maintainerCanModify: true,
        })),
        hasOpenPullRequestForBranch: () => Promise.resolve(ok(false)),
        isBranchProtected: () => Promise.reject(new Error('External branch protection is enforced by GitHub.')),
      },
      remoteUrl: (repository) => {
        remotes.push(repository)
        return bare
      },
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })
    const signal = new AbortController().signal

    expect(await remote.validateAuthority(conflict, signal)).toEqual(ok(undefined))
    expect(await remote.getHeadSha(conflict, signal)).toEqual(ok(conflict.expectedHeadSha))
    expect(remotes).toContain(headRepository)
  })

  it('publishes the prepared descendant with an exact head lease', async () => {
    const { bare, command, expectedHeadSha, root } = fixture()
    const remote = createGitPublicationRemote({
      github: {
        getPullRequest: () => Promise.resolve(ok({
          kind: 'pull_request',
          approvalLabels: [],
          autoMerge: false,
          repository: command.repository,
          number: 1,
          state: 'open',
          mergedAt: null,
          title: 'Fix',
          author: 'harlan-zw',
          url: 'https://github.com/harlan-zw/example/pull/1',
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-13T00:00:00.000Z',
          draft: false,
          baseSha: 'stale-pull-request-base-sha',
          headSha: command.expectedHeadSha,
          headRepository: command.repository,
          headRef: command.headRef,
          mergeState: 'conflicting',
          priorAutomatedReview: { _tag: 'None' },
        })),
        hasOpenPullRequestForBranch: () => Promise.resolve(ok(false)),
        isBranchProtected: () => Promise.resolve(ok(false)),
      },
      remoteUrl: () => bare,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })
    const signal = new AbortController().signal

    expect(await remote.validateAuthority(command, signal)).toEqual(ok(undefined))
    expect(await remote.getHeadSha(command, signal)).toEqual(ok(expectedHeadSha))
    expect(await remote.push(command, signal)).toEqual(ok(undefined))
    expect(await remote.getHeadSha(command, signal)).toEqual(ok(command.commitSha))
  })

  it('rejects publication after another writer changes the branch', async () => {
    const { bare, checkout, command, root } = fixture()
    writeFileSync(join(checkout, 'other.txt'), 'other\n')
    git(checkout, 'add', 'other.txt')
    git(checkout, 'commit', '-m', 'competing change')
    git(checkout, 'push', 'origin', `HEAD:refs/heads/${command.headRef}`)
    const remote = createGitPublicationRemote({
      github: {
        getPullRequest: () => Promise.reject(new Error('Not needed.')),
        hasOpenPullRequestForBranch: () => Promise.resolve(ok(false)),
        isBranchProtected: () => Promise.reject(new Error('Not needed.')),
      },
      remoteUrl: () => bare,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })

    const result = await remote.push(command, new AbortController().signal)

    expect(result._tag).toBe('Err')
  })

  it('rejects publication after the base branch moves', async () => {
    const { bare, checkout, command, root } = fixture()
    git(checkout, 'checkout', 'main')
    writeFileSync(join(checkout, 'later.txt'), 'later base change\n')
    git(checkout, 'add', 'later.txt')
    git(checkout, 'commit', '-m', 'later base change')
    git(checkout, 'push', 'origin', 'main')
    const remote = createGitPublicationRemote({
      github: {
        getPullRequest: () => Promise.resolve(ok(pullRequestItem({
          repository: command.repository,
          number: 1,
          baseSha: 'stale-pull-request-base-sha',
          headSha: command.expectedHeadSha,
          headRepository: command.repository,
          headRef: command.headRef,
        }))),
        hasOpenPullRequestForBranch: () => Promise.resolve(ok(false)),
        isBranchProtected: () => Promise.resolve(ok(false)),
      },
      remoteUrl: () => bare,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })

    expect(await remote.validateAuthority(command, new AbortController().signal)).toEqual({
      _tag: 'Err',
      error: 'The base branch changed before publication.',
    })
  })
})
