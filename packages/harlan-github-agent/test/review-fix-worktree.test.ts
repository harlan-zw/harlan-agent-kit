import type { RepairRecoveryTarget } from '../src/repair-recovery.ts'
import type { ClaimedAdversarialReviewTask, ClaimedReviewFixTask } from '../src/types.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { err, ok } from '../src/result.ts'
import { agentWorktreeBranch, createAgentWorkspaceManager, createGitPublicationRemote, createRepairRecoveryWorktreeManager, createReviewFixWorktreeManager } from '../src/worktree.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

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
      pullRequest: pullRequestItem({ number: 1, baseSha, headSha, headRef: 'fix/review', mergeState: 'clean' }),
      rounds: { number: 1, limit: 3, prior: [] },
    },
  }
}

describe('review fix worktree', () => {
  it.each(['Reuse', 'Port', 'wrong-ref', 'merge', 'empty', 'conflict', 'checks-fail', 'patch-change', 'evidence-missing'])('checks a retained Repair on the current base: %s', async (mode) => {
    const { remote, root, task } = fixture()
    const checkout = task.repositoryMapping.checkout
    git(checkout, 'checkout', 'main')
    writeFileSync(join(checkout, 'package.json'), '{"name":"recovery-fixture","private":true}')
    writeFileSync(join(checkout, '.gitignore'), 'node_modules/\n')
    writeFileSync(join(checkout, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n')
    git(checkout, 'add', '.')
    git(checkout, 'commit', '-m', 'prepare checks')
    const parentSha = git(checkout, 'rev-parse', 'HEAD')
    task.id = `logged-finding:${'a'.repeat(64)}`
    task.pickup = { _tag: 'LoggedFinding', finding: { _tag: 'Logged', impact: 40, summary: 'Keep input', details: { fingerprint: 'f'.repeat(64), identity: 'parser', proof: 'Loses input', location: { path: 'file.ts', line: 1 } } } }
    task.pullRequest = { ...task.pullRequest, state: 'closed', mergedAt: '2026-10-06' }
    const branch = agentWorktreeBranch('fix-1-ffffffffffff', { taskId: task.id, fence: 1 })
    git(checkout, 'checkout', '-b', branch)
    writeFileSync(join(checkout, 'file.ts'), 'export const value = 3\n')
    writeFileSync(join(checkout, 'file.test.ts'), 'export const selectedRegression = true\n')
    git(checkout, 'add', '.')
    git(checkout, 'commit', '-m', 'retain repair')
    if (mode === 'merge')
      git(checkout, 'merge', '--no-ff', '-s', 'ours', 'fix/review', '-m', 'merge artifact')
    const commitSha = git(checkout, 'rev-parse', 'HEAD')
    git(checkout, 'checkout', 'main')
    if (mode === 'empty')
      git(checkout, 'cherry-pick', commitSha)
    if (mode === 'Port') {
      writeFileSync(join(checkout, 'other.ts'), 'export const unrelated = 1\n')
      git(checkout, 'add', '.')
      git(checkout, 'commit', '-m', 'move base')
    }
    if (mode === 'conflict') {
      writeFileSync(join(checkout, 'file.ts'), 'export const value = 4\n')
      git(checkout, 'commit', '-am', 'conflicting base')
    }
    const expectedBase = git(checkout, 'rev-parse', 'HEAD')
    git(checkout, 'push', 'origin', 'main')
    const target: RepairRecoveryTarget = { task, fence: 1, proof: { _tag: 'RepairRecovery', commitSha, originalFence: 1, originalFailure: 'saved pin' }, report: { summary: 'Keep input', checks: ['prior checks'] } }
    if (mode === 'wrong-ref')
      git(checkout, 'branch', '-f', branch, parentSha)
    task.state = { ...task.state, fence: 2 }
    let red = 0
    let green = 0
    const manager = createRepairRecoveryWorktreeManager({ root, remoteUrl: () => remote, gitIdentity: { name: 'Test Author', email: 'author@example.com' }, tokens: { getToken: async () => ok({ token: 'unused', expiresAt: '2126-01-01T00:00:00Z' }), invalidate: () => undefined }, confirmRegression: async (path) => {
      red += 1
      expect(readFileSync(join(path, 'file.ts'), 'utf8')).toContain('value = 1')
      return mode === 'evidence-missing' ? err('No current assertion failure.') : ok(undefined)
    }, runChecks: async (path) => {
      green += 1
      expect(readFileSync(join(path, 'file.ts'), 'utf8')).toContain('value = 3')
      if (mode === 'patch-change')
        writeFileSync(join(path, 'other.ts'), 'unexpected check output\n')
      return mode === 'checks-fail' ? err('Fresh checks failed.') : ok(['check passed'])
    }, runCommand: async () => ({ exitCode: 0 }), recordChecks: () => true })
    const signal = new AbortController().signal
    const artifact = await manager.inspectRecovery(target, signal)
    if (mode === 'wrong-ref' || mode === 'merge') {
      expect(artifact._tag).toBe('Err')
      return
    }
    if (artifact._tag === 'Err')
      throw new Error(artifact.error)
    const result = await manager.recover(task, target, { ...artifact.value, _tag: 'Plan', taskId: task.id, repository: task.repository, pullRequestNumber: 1, commitSha, expectedBase, operation: expectedBase === parentSha ? 'Reuse' : 'Port', checks: [] }, signal)
    if (!['Reuse', 'Port'].includes(mode)) {
      expect(result._tag).toBe('Err')
      expect(git(checkout, 'rev-parse', `refs/heads/${branch}`)).toBe(commitSha)
      return
    }
    if (result._tag === 'Err')
      throw new Error(typeof result.error === 'string' ? result.error : result.error.reason)
    expect(result.value.baseSha).toBe(expectedBase)
    expect(red).toBe(1)
    expect(green).toBe(1)
    expect(result.value.commitSha === commitSha).toBe(mode === 'Reuse')
  }, 30_000)
  it('reports an unchanged worktree without losing the Agent result', async () => {
    const { root, task, remote } = fixture()
    const manager = createReviewFixWorktreeManager({
      gitIdentity: { name: 'Test Author', email: 'author@example.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: async () => ok({ token: 'unused', expiresAt: '2126-01-01T00:00:00Z' }), invalidate: () => undefined },
    })
    const signal = new AbortController().signal
    const prepared = await manager.prepare(task, signal)
    if (prepared._tag === 'Err')
      throw new Error(prepared.error)
    expect(await manager.verify(task, prepared.value, signal)).toEqual(ok(expect.objectContaining({ changedFiles: 0 })))
    expect(git(prepared.value.path, 'status', '--porcelain')).toBe('')
  })

  it('rejects any file change made during read only Review', async () => {
    const { remote, root, task } = fixture()
    const reviewTask: ClaimedAdversarialReviewTask = {
      ...task,
      kind: 'adversarial_review',
      rerun: { _tag: 'NotRequested' },
    }
    const manager = createAgentWorkspaceManager({
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })
    const prepared = await manager.prepareReview(reviewTask, new AbortController().signal)
    if (prepared._tag === 'Err')
      throw new Error(prepared.error)
    expect(await manager.verifyReview(reviewTask, prepared.value, new AbortController().signal)).toEqual(ok(undefined))
    writeFileSync(join(prepared.value.path, 'file.ts'), 'export const value = 3\n')

    expect(await manager.verifyReview(reviewTask, prepared.value, new AbortController().signal)).toEqual({
      _tag: 'Err',
      error: 'The Review Agent changed files. Review must stay read only.',
    })
  })

  it('rejects workflow edits that the controller cannot publish to a contributor fork', async () => {
    const { remote, root, task } = fixture()
    task.pullRequest = pullRequestItem({
      ...task.pullRequest,
      author: 'contributor',
      headRepository: 'contributor/example',
      maintainerCanModify: true,
    })
    const manager = createReviewFixWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve({ _tag: 'Ok', value: { token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' } }), invalidate: () => undefined },
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

  it.each([
    { merged: false, pickup: false, taskId: 'fix-task-1' },
    { merged: true, pickup: false, taskId: 'fix-task-1' },
    { merged: true, pickup: true, taskId: `logged-finding:${'f'.repeat(64)}` },
    { merged: false, pickup: false, taskId: 'task with..invalid/ref\ncharacters.lock' },
  ])('publishes a verified Repair: %j', async ({ merged, pickup, taskId }) => {
    const { remote, root, task } = fixture()
    task.id = taskId
    if (merged) {
      const checkout = task.repositoryMapping.checkout
      git(checkout, 'checkout', 'main')
      git(checkout, 'merge', '--ff-only', 'fix/review')
      writeFileSync(join(checkout, 'later.ts'), 'export const later = true\n')
      git(checkout, 'add', 'later.ts')
      git(checkout, 'commit', '-m', 'later change')
      git(checkout, 'push', 'origin', 'main', ':fix/review')
      task.pullRequest = { ...task.pullRequest, state: 'closed', mergedAt: '2026-08-13T01:00:00.000Z' }
    }
    if (pickup) {
      task.pickup = { _tag: 'LoggedFinding', finding: {
        _tag: 'Logged',
        impact: 40,
        summary: 'Buffered bytes disappear.',
        details: { fingerprint: 'f'.repeat(64), identity: 'buffered bytes', location: { path: 'file.ts', line: 1 }, proof: 'The parser loses bytes.' },
      } }
    }
    const profile = signingProfile(root)
    const manager = createReviewFixWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve({ _tag: 'Ok', value: { token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' } }), invalidate: () => undefined },
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
    expect(git(join(root, 'repositories', 'harlan-zw__example.git'), 'rev-parse', committed.value.artifactRef)).toBe(committed.value.commitSha)
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
    expect(git(prepared.value.path, 'show', '--no-patch', '--format=%P')).toBe(prepared.value.headSha)
    const publisher = createGitPublicationRemote({
      github: {
        getPullRequest: () => Promise.resolve(ok(task.pullRequest)),
        hasOpenPullRequestForBranch: () => Promise.resolve(ok(false)),
        isBranchProtected: () => Promise.resolve(ok(false)),
      },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve(ok({ token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' })), invalidate: () => undefined },
    })
    const command = {
      ...(merged ? { _tag: 'OpenPullRequest' as const, pullRequestTitle: 'fix: preserve bytes', pullRequestBody: 'Fix findings after merge.' } : { _tag: 'UpdatePullRequest' as const }),
      id: 'publication-1',
      taskId: task.id,
      taskKind: 'review_fix' as const,
      repository: task.repository,
      pullRequestNumber: task.pullRequestNumber,
      commitSha: committed.value.commitSha,
      baseSha: committed.value.baseSha,
      baseRef: 'main',
      expectedHeadSha: merged ? prepared.value.baseSha : task.pullRequest.headSha,
      headRef: merged ? 'fix/merged-review-1' : task.pullRequest.headRef,
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
    expect(git(remote, 'rev-parse', `refs/heads/${command.headRef}`)).toBe(committed.value.commitSha)
    if (merged) {
      expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(prepared.value.baseSha)
      expect(git(remote, 'branch', '--list', 'fix/review')).toBe('')
      expect(readFileSync(join(prepared.value.path, 'later.ts'), 'utf8')).toContain('later = true')
    }
  })
})
