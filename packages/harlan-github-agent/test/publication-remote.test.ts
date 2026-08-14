import type { ClaimedPublicationCommand } from '../src/types.ts'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { createGitPublicationRemote } from '../src/worktree.ts'
import { pullRequestSubject, repositoryMapping } from './fixtures.ts'

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
  it('authorizes an approved repair while the pull request remains clean', async () => {
    const { bare, command, root } = fixture()
    const repair = { ...command, taskKind: 'review_fix' as const }
    const remote = createGitPublicationRemote({
      github: {
        getPullRequest: () => Promise.resolve(ok(pullRequestSubject({
          repository: repair.repository,
          number: 1,
          baseSha: repair.baseSha,
          headSha: repair.expectedHeadSha,
          headRepository: repair.repository,
          headRef: repair.headRef,
          mergeState: 'clean',
        }))),
        isBranchProtected: () => Promise.resolve(ok(false)),
      },
      remoteUrl: () => bare,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })) },
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
          ...pullRequestSubject({
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
        isBranchProtected: () => Promise.reject(new Error('External branch protection is enforced by GitHub.')),
      },
      remoteUrl: (repository) => {
        remotes.push(repository)
        return bare
      },
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })) },
    })
    const signal = new AbortController().signal

    expect(await remote.validateAuthority(repair, signal)).toEqual(ok(undefined))
    expect(await remote.getHeadSha(repair, signal)).toEqual(ok(repair.expectedHeadSha))
    expect(remotes).toContain(headRepository)
  })

  it('publishes the prepared descendant with an exact head lease', async () => {
    const { bare, command, expectedHeadSha, root } = fixture()
    const remote = createGitPublicationRemote({
      github: {
        getPullRequest: () => Promise.resolve(ok({
          kind: 'pull_request',
          approvalLabels: [],
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
        isBranchProtected: () => Promise.resolve(ok(false)),
      },
      remoteUrl: () => bare,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })) },
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
        isBranchProtected: () => Promise.reject(new Error('Not needed.')),
      },
      remoteUrl: () => bare,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })) },
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
        getPullRequest: () => Promise.resolve(ok(pullRequestSubject({
          repository: command.repository,
          number: 1,
          baseSha: 'stale-pull-request-base-sha',
          headSha: command.expectedHeadSha,
          headRepository: command.repository,
          headRef: command.headRef,
        }))),
        isBranchProtected: () => Promise.resolve(ok(false)),
      },
      remoteUrl: () => bare,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })) },
    })

    expect(await remote.validateAuthority(command, new AbortController().signal)).toEqual({
      _tag: 'Err',
      error: 'The base branch changed before publication.',
    })
  })
})
