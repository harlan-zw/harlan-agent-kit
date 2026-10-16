import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RestoreDependencies, SnapshotAccess } from '../src/cloudflare-snapshots.ts'
import {
  decodeBranch,
  encodeBranch,
  parseLinkedWorktrees,
  pruneFinished,
  repositoryNameFromRemote,
  restoreSnapshots,
  runGit,
  snapshotRound,
} from '../src/cloudflare-snapshots.ts'

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } }).trim()
}

describe('names', () => {
  it('keeps branches with slashes apart in the ref tree', () => {
    expect(encodeBranch('feat/dashboard-settings')).toBe('feat%2Fdashboard-settings')
    expect(encodeBranch('a')).not.toBe(encodeBranch('a/b'))
    expect(decodeBranch(encodeBranch('fix/odd name~1'))).toBe('fix/odd name~1')
    expect(encodeBranch('.hidden')).toBe('%2Ehidden')
  })

  it('derives the Artifacts repository from a GitHub remote', () => {
    expect(repositoryNameFromRemote('https://github.com/Wolfstar-Project/Staryl.git')).toBe('wolfstar-project-staryl')
    expect(repositoryNameFromRemote('git@github.com:wolfstar-project/staryl')).toBe('wolfstar-project-staryl')
    expect(repositoryNameFromRemote('https://gitlab.com/a/b.git')).toBeNull()
  })

  it('reads linked worktrees and skips the main checkout and detached heads', () => {
    const listing = [
      'worktree /home/node/pkg/staryl',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree /home/node/pkg/staryl.feat-x',
      'HEAD bbb',
      'branch refs/heads/feat/x',
      '',
      'worktree /home/node/pkg/staryl.detached',
      'HEAD ccc',
      'detached',
      '',
    ].join('\n')
    expect(parseLinkedWorktrees(listing)).toEqual([
      { path: '/home/node/pkg/staryl.feat-x', head: 'bbb', branch: 'feat/x' },
    ])
  })
})

describe('snapshots of worktrees', () => {
  let root: string
  let remote: string
  let now = Math.floor(Date.now() / 1000)
  let accessCalls: string[]

  const lostContainer = () => join(root, 'lost')
  const checkoutOf = (container: string) => join(container, 'staryl')

  /** A GitHub repository clone: `main` published as origin/main, one linked worktree on `feat/x`. */
  function makeContainer(container: string, { withWork }: { withWork: boolean }): string {
    const checkout = checkoutOf(container)
    mkdirSync(checkout, { recursive: true })
    git(checkout, 'init', '-q', '-b', 'main')
    writeFileSync(join(checkout, 'README.md'), 'hello\n')
    writeFileSync(join(checkout, '.gitignore'), 'node_modules\n')
    git(checkout, 'add', '-A')
    git(checkout, 'commit', '-q', '-m', 'init')
    git(checkout, 'remote', 'add', 'origin', 'https://github.com/wolfstar-project/staryl.git')
    git(checkout, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(checkout, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    if (withWork) git(checkout, 'worktree', 'add', '-q', '-b', 'feat/x', join(container, 'staryl.feat-x'))
    return checkout
  }

  function dependencies(): RestoreDependencies {
    return {
      git: (args, options) => runGit(args, { ...options, env: { ...IDENTITY, ...options?.env } }),
      request: async (repository, scope): Promise<SnapshotAccess | null> => {
        accessCalls.push(`${scope}:${repository}`)
        return { remote, token: 'art_v1_test' }
      },
      log: () => undefined,
      now: () => now,
      createWorktree: async (checkout, branch, base) => {
        const path = `${checkout}.${encodeBranch(branch)}`
        git(checkout, 'worktree', 'add', '-q', '-b', branch, path, base)
        return path
      },
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wolfstar-snapshots-'))
    remote = join(root, 'artifacts.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
    accessCalls = []
    now = Math.floor(Date.now() / 1000)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('asks for nothing while a worktree holds no work', async () => {
    const checkout = makeContainer(lostContainer(), { withWork: true })

    const round = await snapshotRound(dependencies(), [checkout])

    expect(round.saved).toEqual([])
    expect(accessCalls).toEqual([])
    expect(git(remote, 'for-each-ref')).toBe('')
  })

  it('saves modified and new files, leaves secrets and oversized files out, and leaves the worktree alone', async () => {
    const checkout = makeContainer(lostContainer(), { withWork: true })
    const worktree = join(lostContainer(), 'staryl.feat-x')
    writeFileSync(join(worktree, 'README.md'), 'hello from the agent\n')
    writeFileSync(join(worktree, 'feature.ts'), 'export const feature = true\n')
    writeFileSync(join(worktree, '.env'), 'TOKEN=secret\n')
    writeFileSync(join(worktree, 'deploy.pem'), 'PRIVATE\n')
    mkdirSync(join(worktree, 'node_modules'))
    writeFileSync(join(worktree, 'node_modules', 'ignored.js'), 'x\n')
    writeFileSync(join(worktree, 'huge.bin'), '')
    truncateSync(join(worktree, 'huge.bin'), 31 * 1024 * 1024)
    const statusBefore = git(worktree, 'status', '--porcelain')

    const round = await snapshotRound(dependencies(), [checkout])

    expect(round.saved).toEqual(['feat/x'])
    expect(accessCalls).toEqual(['write:wolfstar-project-staryl'])
    const files = git(remote, 'ls-tree', '-r', '--name-only', 'refs/heads/snapshots/feat%2Fx').split('\n')
    expect(files).toEqual(['.gitignore', 'README.md', 'feature.ts'])
    expect(git(remote, 'log', '-1', '--format=%B', 'refs/heads/snapshots/feat%2Fx')).toContain('Branch: feat/x')
    // Nothing moved in the worktree: same changes, same staging.
    expect(git(worktree, 'status', '--porcelain')).toBe(statusBefore)
    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('TOKEN=secret\n')
  })

  it('chains snapshots, and skips a round when nothing changed', async () => {
    const checkout = makeContainer(lostContainer(), { withWork: true })
    const worktree = join(lostContainer(), 'staryl.feat-x')
    writeFileSync(join(worktree, 'a.txt'), '1\n')
    expect((await snapshotRound(dependencies(), [checkout])).saved).toEqual(['feat/x'])
    const first = git(remote, 'rev-parse', 'refs/heads/snapshots/feat%2Fx')

    expect((await snapshotRound(dependencies(), [checkout])).saved).toEqual([])
    expect(git(remote, 'rev-parse', 'refs/heads/snapshots/feat%2Fx')).toBe(first)

    writeFileSync(join(worktree, 'a.txt'), '2\n')
    expect((await snapshotRound(dependencies(), [checkout])).saved).toEqual(['feat/x'])
    const second = git(remote, 'rev-parse', 'refs/heads/snapshots/feat%2Fx')
    expect(second).not.toBe(first)
    expect(git(remote, 'rev-parse', `${second}^`)).toBe(first)
  })

  it('counts a commit that was never pushed as work to save', async () => {
    const checkout = makeContainer(lostContainer(), { withWork: true })
    const worktree = join(lostContainer(), 'staryl.feat-x')
    writeFileSync(join(worktree, 'done.txt'), 'committed locally\n')
    git(worktree, 'add', '-A')
    git(worktree, 'commit', '-q', '-m', 'work')

    expect((await snapshotRound(dependencies(), [checkout])).saved).toEqual(['feat/x'])
    expect(git(remote, 'ls-tree', '-r', '--name-only', 'refs/heads/snapshots/feat%2Fx')).toContain('done.txt')
  })

  it('reports a failed push and keeps going', async () => {
    const checkout = makeContainer(lostContainer(), { withWork: true })
    writeFileSync(join(lostContainer(), 'staryl.feat-x', 'a.txt'), '1\n')
    const broken = { ...dependencies(), request: async () => ({ remote: join(root, 'missing.git'), token: 't' }) }

    const round = await snapshotRound(broken, [checkout])

    expect(round.saved).toEqual([])
    expect(round.failed).toHaveLength(1)
    expect(round.failed[0]!.branch).toBe('feat/x')
  })

  it('brings the work back in a new container, as unstaged changes on the merge base', async () => {
    const lost = makeContainer(lostContainer(), { withWork: true })
    const worktree = join(lostContainer(), 'staryl.feat-x')
    writeFileSync(join(worktree, 'README.md'), 'edited by the agent\n')
    writeFileSync(join(worktree, 'new.ts'), 'export {}\n')
    await snapshotRound(dependencies(), [lost])

    // The old container is gone. The new one has a clean clone and no worktree.
    const fresh = makeContainer(join(root, 'fresh'), { withWork: false })
    const outcomes = await restoreSnapshots(dependencies(), fresh)

    expect(outcomes).toEqual([{ _tag: 'Restored', branch: 'feat/x', path: `${fresh}.feat%2Fx` }])
    const restored = `${fresh}.feat%2Fx`
    expect(readFileSync(join(restored, 'README.md'), 'utf8')).toBe('edited by the agent\n')
    expect(existsSync(join(restored, 'new.ts'))).toBe(true)
    expect(git(restored, 'branch', '--show-current')).toBe('feat/x')
    // Unstaged: the index still matches the merge base.
    expect(git(restored, 'diff', '--cached', '--name-only')).toBe('')
    expect(git(restored, 'diff', '--name-only')).toBe('README.md')
    expect(git(restored, 'ls-files', '--others', '--exclude-standard')).toBe('new.ts')
  })

  it('leaves a branch that already exists alone, and ignores an old snapshot', async () => {
    const lost = makeContainer(lostContainer(), { withWork: true })
    writeFileSync(join(lostContainer(), 'staryl.feat-x', 'a.txt'), '1\n')
    await snapshotRound(dependencies(), [lost])

    const existing = makeContainer(join(root, 'existing'), { withWork: true })
    expect(await restoreSnapshots(dependencies(), existing)).toEqual([
      { _tag: 'Skipped', branch: 'feat/x', reason: 'the branch already exists here' },
    ])

    now += 4 * 24 * 60 * 60
    const fresh = makeContainer(join(root, 'fresh'), { withWork: false })
    const outcomes = await restoreSnapshots(dependencies(), fresh)
    expect(outcomes).toEqual([{ _tag: 'Skipped', branch: 'feat/x', reason: 'older than three days' }])
    expect(existsSync(`${fresh}.feat%2Fx`)).toBe(false)
  })

  it('restores nothing, and creates nothing, when no snapshot was ever saved', async () => {
    const fresh = makeContainer(join(root, 'fresh'), { withWork: false })
    const deps = { ...dependencies(), request: async () => null }
    expect(await restoreSnapshots(deps, fresh)).toEqual([])
  })

  it('removes the snapshot of a worktree that finished, and only that one', async () => {
    const lost = makeContainer(lostContainer(), { withWork: true })
    writeFileSync(join(lostContainer(), 'staryl.feat-x', 'a.txt'), '1\n')
    await snapshotRound(dependencies(), [lost])
    git(remote, 'update-ref', 'refs/heads/snapshots/other', git(remote, 'rev-parse', 'refs/heads/snapshots/feat%2Fx'))

    expect(await pruneFinished(dependencies(), lost, ['feat/x'])).toEqual(['feat/x'])
    expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/snapshots/other')
    expect(await pruneFinished(dependencies(), lost, [])).toEqual([])
  })
})
