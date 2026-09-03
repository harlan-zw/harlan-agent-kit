import type { PrepareCommandRequest } from '../src/repository-prepare.ts'
import type { ClaimedIssueTriageTask, ClaimedIssueWorkTask } from '../src/types.ts'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { createPrepareCommandRunner } from '../src/repository-prepare.ts'
import { createAgentWorkspaceManager } from '../src/worktree.ts'
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

function fixture(commands: string[], runner: (request: PrepareCommandRequest) => ReturnType<ReturnType<typeof createPrepareCommandRunner>>) {
  const directory = mkdtempSync(join(tmpdir(), 'harlan-prepare-'))
  temporaryDirectories.push(directory)
  const remote = join(directory, 'remote.git')
  const checkout = join(directory, 'checkout')
  execFileSync('git', ['init', '--bare', remote])
  execFileSync('git', ['clone', remote, checkout])
  git(checkout, 'config', 'user.name', 'Test Author')
  git(checkout, 'config', 'user.email', 'author@example.com')
  git(checkout, 'checkout', '-b', 'main')
  writeFileSync(join(checkout, 'file.ts'), 'export const value = 1\n')
  git(checkout, 'add', 'file.ts')
  git(checkout, 'commit', '-m', 'initial')
  git(checkout, 'push', 'origin', 'main')
  const mapping = repositoryMapping({ checkout, prepare: { commands, timeoutSeconds: 5 } })
  const manager = createAgentWorkspaceManager({
    prepare: runner,
    remoteUrl: () => remote,
    root: join(directory, 'controller'),
    tokens: { getToken: () => Promise.resolve({ _tag: 'Ok', value: { token: 'unused', expiresAt: '2026-08-13T02:00:00.000Z' } }), invalidate: () => undefined },
  })
  const base = { id: 'issue-1', repository: mapping.github, issueNumber: 12, revisionId: 'revision-1', updatedAt: '2026-08-13T01:00:00.000Z', state: { _tag: 'Running' as const, workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T01:10:00.000Z' }, repositoryMapping: mapping, issue: issueItem() }
  const work: ClaimedIssueWorkTask = { ...base, kind: 'issue_work' }
  const triage: ClaimedIssueTriageTask = { ...base, kind: 'issue_triage' }
  return { manager, work, triage }
}

describe('repository prepare', () => {
  it('runs every prepare command inside the task worktree before Issue work starts', async () => {
    const requests: PrepareCommandRequest[] = []
    const { manager, work } = fixture(['pnpm exec nuxt prepare', 'pnpm build:protocol'], (request) => {
      requests.push(request)
      return Promise.resolve({ _tag: 'Exited', exitCode: 0, outputTail: [] })
    })

    const prepared = await manager.prepareIssue(work, { _tag: 'DefaultBranch', ref: 'main' }, new AbortController().signal)

    if (prepared._tag === 'Err')
      throw new Error(prepared.error)
    expect(requests).toEqual([
      { argv: ['pnpm', 'exec', 'nuxt', 'prepare'], cwd: prepared.value.path, timeoutMilliseconds: 5_000, signal: expect.any(AbortSignal) },
      { argv: ['pnpm', 'build:protocol'], cwd: prepared.value.path, timeoutMilliseconds: 5_000, signal: expect.any(AbortSignal) },
    ])
  })

  it('never runs prepare for read only Issue triage', async () => {
    const requests: PrepareCommandRequest[] = []
    const { manager, triage } = fixture(['pnpm exec nuxt prepare'], (request) => {
      requests.push(request)
      return Promise.resolve({ _tag: 'Exited', exitCode: 0, outputTail: [] })
    })

    const prepared = await manager.prepareIssue(triage, { _tag: 'DefaultBranch', ref: 'main' }, new AbortController().signal)

    expect(prepared._tag).toBe('Ok')
    expect(requests).toEqual([])
  })

  it('stops the workspace with the command and output tail when a prepare command fails', async () => {
    const { manager, work } = fixture(['pnpm exec nuxt prepare'], () => Promise.resolve({
      _tag: 'Exited',
      exitCode: 1,
      outputTail: ['[nuxt] preparing', 'ERROR Cannot find module nuxt'],
    }))

    const prepared = await manager.prepareIssue(work, { _tag: 'DefaultBranch', ref: 'main' }, new AbortController().signal)

    expect(prepared).toEqual({
      _tag: 'Err',
      error: 'Repository prepare command `pnpm exec nuxt prepare` exited with code 1.\n[nuxt] preparing\nERROR Cannot find module nuxt',
    })
  })

  it('reports a timed out prepare command with its output tail', async () => {
    const { manager, work } = fixture(['pnpm exec nuxt prepare'], () => Promise.resolve({ _tag: 'TimedOut', outputTail: ['still resolving'] }))

    const prepared = await manager.prepareIssue(work, { _tag: 'DefaultBranch', ref: 'main' }, new AbortController().signal)

    expect(prepared).toEqual({
      _tag: 'Err',
      error: 'Repository prepare command `pnpm exec nuxt prepare` timed out after 5 seconds.\nstill resolving',
    })
  })
})

describe('prepare command runner', () => {
  it('runs the command with the worktree bin directory on PATH and keeps the output tail', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'harlan-prepare-runner-'))
    temporaryDirectories.push(cwd)
    const result = await createPrepareCommandRunner()({
      argv: ['node', '-e', 'console.log(process.env.PATH.split(":")[0]); console.error("warned"); process.exit(3)'],
      cwd,
      timeoutMilliseconds: 5_000,
      signal: new AbortController().signal,
    })

    expect(result).toEqual({ _tag: 'Exited', exitCode: 3, outputTail: [join(cwd, 'node_modules', '.bin'), 'warned'] })
  })

  it('kills a command that outlives its timeout', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'harlan-prepare-runner-'))
    temporaryDirectories.push(cwd)
    const result = await createPrepareCommandRunner()({
      argv: ['node', '-e', 'console.log("started"); setTimeout(() => {}, 60_000)'],
      cwd,
      timeoutMilliseconds: 300,
      signal: new AbortController().signal,
    })

    expect(result).toEqual({ _tag: 'TimedOut', outputTail: ['started'] })
  })

  it('kills the grandchildren of a command that outlives its timeout', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'harlan-prepare-runner-'))
    temporaryDirectories.push(cwd)
    const pidFile = join(cwd, 'grandchild.pid')
    const result = await createPrepareCommandRunner()({
      argv: ['node', '-e', `
        const { spawn } = require('node:child_process')
        const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid))
        setTimeout(() => {}, 60_000)
      `],
      cwd,
      timeoutMilliseconds: 500,
      signal: new AbortController().signal,
    })
    const grandchild = Number(readFileSync(pidFile, 'utf8'))

    expect(result).toEqual({ _tag: 'TimedOut', outputTail: [] })
    await expect.poll(() => isRunning(grandchild), { timeout: 3_000 }).toBe(false)
  })
})

/** True while the process exists. A zombie of this test's own tree still counts as gone once it is reaped. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z'
  }
  catch {
    return false
  }
}

describe('prepare command runner spawn failure', () => {
  it('names a command that never started', async () => {
    const result = await createPrepareCommandRunner()({ argv: ['definitely-missing-prepare-binary'], cwd: tmpdir(), timeoutMilliseconds: 3_000, signal: new AbortController().signal })

    expect(result).toEqual({ _tag: 'Failed', reason: expect.stringContaining('ENOENT'), outputTail: [] })
  })
})
