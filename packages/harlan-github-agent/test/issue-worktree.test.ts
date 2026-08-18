import type { ClaimedIssueWorkTask, PullRequestBase } from '../src/types.ts'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createIssueWorktreeManager } from '../src/worktree.ts'
import { issueItem, repositoryMapping } from './fixtures.ts'

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

interface Fixture {
  baseSha: string
  checkout: string
  manager: ReturnType<typeof createIssueWorktreeManager>
  remote: string
  root: string
  task: ClaimedIssueWorkTask
}

function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'harlan-issue-work-'))
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
  const mapping = repositoryMapping({ checkout, defaultBranch: 'main' })
  return {
    baseSha: git(checkout, 'rev-parse', 'HEAD'),
    checkout,
    remote,
    root,
    manager: createIssueWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve({ _tag: 'Ok', value: { token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' } }), invalidate: () => undefined },
    }),
    task: {
      id: 'issue-work-1',
      kind: 'issue_work',
      repository: mapping.github,
      issueNumber: 12,
      revisionId: 'revision-1',
      updatedAt: '2026-08-13T01:00:00.000Z',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T01:10:00.000Z' },
      repositoryMapping: mapping,
      issue: issueItem(),
    },
  }
}

/** Pushes one branch that carries a repair, as an open agent pull request would. */
function pushStackBase(checkout: string, ref: string, contents: string): string {
  git(checkout, 'checkout', '-b', ref, 'main')
  writeFileSync(join(checkout, 'file.ts'), contents)
  git(checkout, 'add', 'file.ts')
  git(checkout, 'commit', '-m', 'fix(ci): repair the default branch')
  git(checkout, 'push', 'origin', ref)
  const head = git(checkout, 'rev-parse', 'HEAD')
  git(checkout, 'checkout', 'main')
  return head
}

const defaultBranch: PullRequestBase = { _tag: 'DefaultBranch', ref: 'main' }

describe('issue worktree', () => {
  it('pins a controller commit based on the approved default branch', async () => {
    const { baseSha, manager, root, task } = fixture()
    const prepared = await manager.prepare(task, defaultBranch, new AbortController().signal)
    if (prepared._tag === 'Err')
      throw new Error(prepared.error)
    expect(prepared.value.defaultBranchSha).toBe(baseSha)
    writeFileSync(join(prepared.value.path, 'file.ts'), 'export const value = 2\n')
    const verified = await manager.verify(task, prepared.value, new AbortController().signal)
    if (verified._tag === 'Err')
      throw new Error(verified.error)
    expect(verified.value.changedPaths).toEqual(['file.ts'])

    const committed = await manager.commit(task, prepared.value, verified.value, 'fix(parser): handle empty input', new AbortController().signal)

    expect(committed).toEqual(expect.objectContaining({ _tag: 'Ok', value: expect.objectContaining({ baseSha, changedFiles: 1 }) }))
    if (committed._tag === 'Err')
      throw new Error(committed.error)
    expect(git(prepared.value.path, 'show', '--no-patch', '--format=%P')).toBe(baseSha)
    expect(git(prepared.value.path, 'show', '--no-patch', '--format=%s')).toBe('fix(parser): handle empty input')
    expect(git(join(root, 'repositories', 'harlan-zw__example.git'), 'rev-parse', committed.value.artifactRef)).toBe(committed.value.commitSha)
  })

  it('starts the worktree on the stack base branch, and still reports the default branch tip', async () => {
    const { baseSha, checkout, manager, task } = fixture()
    const stackHead = pushStackBase(checkout, 'fix/baseline-ci-abcdef012345', 'export const value = 1\nexport const repaired = true\n')

    const prepared = await manager.prepare(task, {
      _tag: 'Stacked',
      ref: 'fix/baseline-ci-abcdef012345',
      pullRequestNumber: 99,
      headSha: stackHead,
    }, new AbortController().signal)

    if (prepared._tag === 'Err')
      throw new Error(prepared.error)
    expect(prepared.value.baseSha).toBe(stackHead)
    expect(prepared.value.defaultBranchSha).toBe(baseSha)
    expect(readFileSync(join(prepared.value.path, 'file.ts'), 'utf8')).toContain('repaired')
  })

  it('moves finished work onto a stack base and commits on top of it', async () => {
    const { checkout, manager, task } = fixture()
    const stackHead = pushStackBase(checkout, 'fix/issue-9', 'export const value = 1\nexport const helper = 1\n')
    const prepared = await manager.prepare(task, defaultBranch, new AbortController().signal)
    if (prepared._tag === 'Err')
      throw new Error(prepared.error)
    writeFileSync(join(prepared.value.path, 'added.ts'), 'export const added = 1\n')
    const verified = await manager.verify(task, prepared.value, new AbortController().signal)
    if (verified._tag === 'Err')
      throw new Error(verified.error)

    const restacked = await manager.restack(task, prepared.value, { headRef: 'fix/issue-9', headSha: stackHead }, new AbortController().signal)

    if (restacked._tag === 'Err')
      throw new Error(restacked.error)
    if (restacked.value._tag === 'Unstacked')
      throw new Error(restacked.value.reason)
    const stackedWorkspace = restacked.value.workspace
    expect(stackedWorkspace.baseSha).toBe(stackHead)
    expect(restacked.value.patch.changedPaths).toEqual(['added.ts'])
    const committed = await manager.commit(task, stackedWorkspace, restacked.value.patch, 'feat(core): add a helper', new AbortController().signal)
    if (committed._tag === 'Err')
      throw new Error(committed.error)
    expect(git(stackedWorkspace.path, 'show', '--no-patch', '--format=%P')).toBe(stackHead)
    expect(readFileSync(join(stackedWorkspace.path, 'file.ts'), 'utf8')).toContain('helper')
  })

  it('falls back to the prepared base when the stack base conflicts', async () => {
    const { baseSha, checkout, manager, task } = fixture()
    const stackHead = pushStackBase(checkout, 'fix/issue-9', 'export const value = 99\n')
    const prepared = await manager.prepare(task, defaultBranch, new AbortController().signal)
    if (prepared._tag === 'Err')
      throw new Error(prepared.error)
    writeFileSync(join(prepared.value.path, 'file.ts'), 'export const value = 2\n')
    const verified = await manager.verify(task, prepared.value, new AbortController().signal)
    if (verified._tag === 'Err')
      throw new Error(verified.error)

    const restacked = await manager.restack(task, prepared.value, { headRef: 'fix/issue-9', headSha: stackHead }, new AbortController().signal)

    if (restacked._tag === 'Err')
      throw new Error(restacked.error)
    expect(restacked.value._tag).toBe('Unstacked')
    // The worktree must be exactly where it was, so the unstacked publication still works.
    const committed = await manager.commit(task, prepared.value, verified.value, 'fix(parser): handle empty input', new AbortController().signal)
    if (committed._tag === 'Err')
      throw new Error(committed.error)
    expect(committed.value.baseSha).toBe(baseSha)
    expect(git(prepared.value.path, 'show', '--no-patch', '--format=%P')).toBe(baseSha)
    // A leftover cherry-pick would hand the commit the wrong subject.
    expect(git(prepared.value.path, 'show', '--no-patch', '--format=%s')).toBe('fix(parser): handle empty input')
    expect(readFileSync(join(prepared.value.path, 'file.ts'), 'utf8')).toBe('export const value = 2\n')
  })
})
