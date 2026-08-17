import type { ClaimedBaselineRepairTask } from '../src/types.ts'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBaselineRepairWorktreeManager } from '../src/worktree.ts'
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

describe('baseline repair worktree', () => {
  it('uses Worktrunk and pins an agent-named commit on the failing base', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'harlan-baseline-repair-'))
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
    const mapping = repositoryMapping({ checkout, defaultBranch: 'main' })
    const task: ClaimedBaselineRepairTask = {
      id: 'baseline-repair-1',
      kind: 'baseline_repair',
      repository: mapping.github,
      pullRequestNumber: 24,
      revisionId: 'revision-1',
      updatedAt: '2026-08-13T01:00:00.000Z',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T01:10:00.000Z' },
      repositoryMapping: mapping,
      pullRequest: pullRequestItem({ baseSha }),
    }
    const manager = createBaselineRepairWorktreeManager({
      gitIdentity: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' },
      remoteUrl: () => remote,
      root,
      tokens: { getToken: () => Promise.resolve({ _tag: 'Ok', value: { token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' } }), invalidate: () => undefined },
    })
    const prepared = await manager.prepare(task, new AbortController().signal)
    if (prepared._tag === 'Err')
      throw new Error(prepared.error)
    writeFileSync(join(prepared.value.path, 'file.ts'), 'export const value = 2\n')
    const verified = await manager.verify(task, prepared.value, new AbortController().signal)
    if (verified._tag === 'Err')
      throw new Error(verified.error)
    const committed = await manager.commit(task, prepared.value, verified.value, 'fix(types): regenerate declarations', new AbortController().signal)
    if (committed._tag === 'Err')
      throw new Error(committed.error)

    expect(git(prepared.value.path, 'show', '--no-patch', '--format=%P')).toBe(baseSha)
    expect(git(prepared.value.path, 'show', '--no-patch', '--format=%s')).toBe('fix(types): regenerate declarations')
    expect(git(join(root, 'repositories', 'harlan-zw__example.git'), 'rev-parse', committed.value.artifactRef)).toBe(committed.value.commitSha)
  })
})
