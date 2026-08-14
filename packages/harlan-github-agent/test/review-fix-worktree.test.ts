import type { ClaimedReviewFixTask } from '../src/types.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { createGitPublicationRemote, createReviewFixWorktreeManager } from '../src/worktree.ts'
import { pullRequestSubject, repositoryMapping } from './fixtures.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  temporaryDirectories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
})

function git(checkout: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-C', checkout, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

function signingProfile(directory: string): { allowedSigners: string, config: string } {
  mkdirSync(directory, { recursive: true })
  const key = join(directory, 'signing-key')
  const config = join(directory, 'gitconfig')
  const allowedSigners = join(directory, 'allowed-signers')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'harlan@harlanzw.com', '-f', key])
  execFileSync('git', ['config', '--file', config, 'user.signingkey', key])
  execFileSync('git', ['config', '--file', config, 'commit.gpgsign', 'true'])
  execFileSync('git', ['config', '--file', config, 'gpg.format', 'ssh'])
  writeFileSync(allowedSigners, `harlan@harlanzw.com ${readFileSync(`${key}.pub`, 'utf8')}`)
  return { allowedSigners, config }
}

function fixture(): { remote: string, root: string, task: ClaimedReviewFixTask } {
  const directory = mkdtempSync(join(tmpdir(), 'harlan-review-fix-'))
  temporaryDirectories.push(directory)
  const remote = join(directory, 'remote.git')
  const checkout = join(directory, 'checkout')
  const root = join(directory, 'controller')
  execFileSync('git', ['init', '--bare', remote])
  execFileSync('git', ['clone', remote, checkout])
  git(checkout, 'config', 'user.name', 'Test Author')
  git(checkout, 'config', 'user.email', 'author@example.com')
  git(checkout, 'checkout', '-b', 'main')
  writeFileSync(join(checkout, 'file.ts'), 'export const value = 1\n')
  git(checkout, 'add', 'file.ts')
  git(checkout, 'commit', '-m', 'initial')
  git(checkout, 'push', 'origin', 'main')
  const baseSha = git(checkout, 'rev-parse', 'HEAD')
  git(checkout, 'checkout', '-b', 'fix/review')
  writeFileSync(join(checkout, 'file.ts'), 'export const value = 2\n')
  git(checkout, 'commit', '-am', 'change')
  const headSha = git(checkout, 'rev-parse', 'HEAD')
  git(checkout, 'push', 'origin', 'fix/review')
  git(checkout, 'push', 'origin', 'HEAD:refs/pull/1/head')
  const mapping = repositoryMapping({ checkout, defaultBranch: 'main' })
  return {
    remote,
    root,
    task: {
      id: 'fix-task-1',
      kind: 'review_fix',
      repository: mapping.github,
      pullRequestNumber: 1,
      revisionId: 'revision-1',
      updatedAt: '2026-08-13T01:00:00.000Z',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T01:10:00.000Z' },
      repositoryMapping: mapping,
      pullRequest: pullRequestSubject({ number: 1, baseSha, headSha, headRef: 'fix/review', mergeState: 'clean' }),
      findings: [{ _tag: 'Open', summary: 'The value is wrong.', nextAction: 'Set the correct value.' }],
    },
  }
}

describe('review fix worktree', () => {
  it('rejects workflow edits that the controller cannot publish to a contributor fork', async () => {
    const { remote, root, task } = fixture()
    task.pullRequest = pullRequestSubject({
      ...task.pullRequest,
      author: 'contributor',
      headRepository: 'contributor/example',
      maintainerCanModify: true,
    })
    const manager = createReviewFixWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve({ _tag: 'Ok', value: { token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' } }) },
    })
    const prepared = await manager.prepare(task, new AbortController().signal)
    if (prepared._tag === 'Err')
      throw new Error(prepared.error)
    const workflows = join(prepared.value.path, '.github', 'workflows')
    mkdirSync(workflows, { recursive: true })
    writeFileSync(join(workflows, 'test.yml'), 'name: Test\n')

    const verified = await manager.verify(task, prepared.value, new AbortController().signal)

    expect(verified).toEqual({
      _tag: 'Err',
      error: 'The controller cannot publish workflow changes to a contributor fork: .github/workflows/test.yml.',
    })
  })

  it('pins a verified repair commit with the configured Git identity', async () => {
    const { remote, root, task } = fixture()
    const profile = signingProfile(root)
    const manager = createReviewFixWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve({ _tag: 'Ok', value: { token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' } }) },
    })
    const prepared = await manager.prepare(task, new AbortController().signal)
    if (prepared._tag === 'Err')
      throw new Error(prepared.error)
    writeFileSync(join(prepared.value.path, 'file.ts'), 'export const value = 3\n')
    writeFileSync(join(prepared.value.path, 'file.test.ts'), 'export const expected = 3\n')
    const verified = await manager.verify(task, prepared.value, new AbortController().signal)
    if (verified._tag === 'Err')
      throw new Error(verified.error)

    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = profile.config
    const committed = await manager.commit(
      task,
      prepared.value,
      verified.value,
      'fix(parser): preserve buffered bytes',
      new AbortController().signal,
    )
      .finally(() => {
        if (previousGlobalConfig === undefined)
          delete process.env.GIT_CONFIG_GLOBAL
        else
          process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig
      })

    expect(committed).toEqual(expect.objectContaining({ _tag: 'Ok', value: expect.objectContaining({ changedFiles: 2 }) }))
    if (committed._tag === 'Err')
      throw new Error(committed.error)
    expect(git(prepared.value.path, 'show', '--no-patch', '--format=%an <%ae>')).toBe('Harlan Wilton <harlan@harlanzw.com>')
    expect(git(prepared.value.path, 'show', '--no-patch', '--format=%s')).toBe('fix(parser): preserve buffered bytes')
    expect(git(
      prepared.value.path,
      '-c',
      'gpg.format=ssh',
      '-c',
      `gpg.ssh.allowedSignersFile=${profile.allowedSigners}`,
      'show',
      '--no-patch',
      '--format=%G?',
    )).toBe('G')
    expect(git(prepared.value.path, 'show', '--no-patch', '--format=%P')).toBe(task.pullRequest.headSha)
    const publisher = createGitPublicationRemote({
      github: {
        getPullRequest: () => Promise.resolve(ok(task.pullRequest)),
        isBranchProtected: () => Promise.resolve(ok(false)),
      },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })) },
    })
    const command = {
      _tag: 'UpdatePullRequest' as const,
      id: 'publication-1',
      taskId: task.id,
      taskKind: 'review_fix' as const,
      repository: task.repository,
      pullRequestNumber: task.pullRequestNumber,
      commitSha: committed.value.commitSha,
      baseSha: committed.value.baseSha,
      expectedHeadSha: task.pullRequest.headSha,
      headRef: task.pullRequest.headRef,
      artifactRef: committed.value.artifactRef,
      patchDigest: committed.value.digest,
      changedFiles: committed.value.changedFiles,
      outcomeUnknown: false,
      workerId: 'publisher-1',
      fence: 1,
      leaseExpiresAt: '2026-08-13T02:00:00.000Z',
      repositoryMapping: task.repositoryMapping,
    }

    expect(await publisher.validateAuthority(command, new AbortController().signal)).toEqual(ok(undefined))
    expect(await publisher.push(command, new AbortController().signal)).toEqual(ok(undefined))
    expect(git(remote, 'rev-parse', 'refs/heads/fix/review')).toBe(committed.value.commitSha)
  })
})
