import type { SessionTurn } from '../src/session-protocol.ts'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireDesktopSessionClaim, releaseDesktopSessionClaim } from '../src/desktop-session-claim.ts'
import { executeDesktopSessionTurn } from '../src/desktop-session-execute.ts'
import { discoverDesktopSessionProjects, prepareDesktopSessionWorkspace, resolveDesktopSessionProject } from '../src/desktop-session-projects.ts'

const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'desktop-projects-'))
  roots.push(home)
  await mkdir(join(home, 'pkg'))
  await mkdir(join(home, 'sites'))
  return home
}
it('discovers immediate repositories and excludes worktrees and symlinks', async () => {
  const home = await fixture()
  const repo = join(home, 'pkg', 'app')
  await exec('git', ['init', repo])
  await mkdir(join(home, 'pkg', 'app.task'))
  await writeFile(join(home, 'pkg', 'app.task', '.git'), 'gitdir: ../app/.git/worktrees/task')
  await symlink(repo, join(home, 'sites', 'alias'))
  await mkdir(join(home, 'pkg', 'nested'))
  await exec('git', ['init', join(home, 'pkg', 'nested', 'hidden')])
  expect(await discoverDesktopSessionProjects(home)).toEqual([{ id: 'pkg/app', name: 'app', path: repo, kind: 'pkg' }])
})
it('rejects traversal and symlink escapes when resolving a selected project', async () => {
  const home = await fixture()
  await symlink(tmpdir(), join(home, 'pkg', 'escape'))
  await expect(resolveDesktopSessionProject(home, 'pkg/escape')).rejects.toThrow()
  await expect(resolveDesktopSessionProject(home, 'pkg/../../etc')).rejects.toThrow()
})
it('skips malformed Git directories without hiding valid projects', async () => {
  const home = await fixture()
  const repo = join(home, 'pkg', 'app')
  await exec('git', ['init', repo])
  await mkdir(join(home, 'sites', 'broken', '.git'), { recursive: true })
  const corrupt = join(home, 'sites', 'corrupt')
  await exec('git', ['init', corrupt])
  await writeFile(join(corrupt, '.git', 'config'), 'invalid configuration\n')
  const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(await discoverDesktopSessionProjects(home)).toEqual([{ id: 'pkg/app', name: 'app', path: repo, kind: 'pkg' }])
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('sites/broken'))
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('sites/corrupt'))
    await expect(resolveDesktopSessionProject(home, 'sites/broken')).rejects.toThrow('Git control checkout')
    await expect(resolveDesktopSessionProject(home, 'sites/corrupt')).rejects.toThrow('Git control checkout')
  }
  finally { diagnostic.mockRestore() }
})
it('propagates infrastructure failures during project discovery', async () => {
  const home = await fixture()
  await exec('git', ['init', join(home, 'pkg', 'app')])
  vi.stubEnv('PATH', '')
  try {
    await expect(discoverDesktopSessionProjects(home)).rejects.toMatchObject({ code: 'ENOENT' })
  }
  finally { vi.unstubAllEnvs() }
})
it('preserves session edits across turns and rejects a substituted Worktree', async () => {
  const home = await fixture()
  const repo = join(home, 'pkg', 'app')
  await exec('git', ['init', '-b', 'main', repo])
  const git = (args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args])
  await git(['config', 'user.name', 'Agent test'])
  await git(['config', 'user.email', 'agent@example.invalid'])
  await writeFile(join(repo, 'file.txt'), 'original')
  await git(['add', '.'])
  await git(['commit', '-m', 'test: seed'])
  const remote = join(home, 'origin.git')
  await exec('git', ['init', '--bare', '-b', 'main', remote])
  await git(['remote', 'add', 'origin', remote])
  await git(['push', 'origin', 'main'])
  await git(['fetch', 'origin'])
  const id = '12345678-1234-1234-1234-123456789abc'
  const signal = new AbortController().signal
  const workspace = await prepareDesktopSessionWorkspace(home, 'pkg/app', id, null, signal)
  await acquireDesktopSessionClaim(workspace, id)
  await expect(acquireDesktopSessionClaim(workspace, 'another-session')).rejects.toThrow()
  await releaseDesktopSessionClaim(workspace, id)
  await acquireDesktopSessionClaim(workspace, 'another-session')
  await releaseDesktopSessionClaim(workspace, 'another-session')
  await writeFile(join(workspace, 'file.txt'), 'session edit')
  expect(await prepareDesktopSessionWorkspace(home, 'pkg/app', id, workspace, signal)).toBe(workspace)
  expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('session edit')
  expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('original')
  await expect(prepareDesktopSessionWorkspace(home, 'pkg/app', id, repo, signal)).rejects.toThrow('unavailable')
  const events: unknown[] = []
  const turn: SessionTurn = {
    sessionId: id,
    turnId: id,
    leaseToken: 'test',
    project: { id: 'pkg/app', name: 'app', path: repo, kind: 'pkg' },
    provider: 'codex',
    model: 'test',
    reasoningEffort: 'high',
    prompt: 'Continue',
    workspacePath: workspace,
    providerSessionId: 'saved-native-session',
  }
  await expect(executeDesktopSessionTurn({
    turn,
    home,
    signal,
    provider: { name: 'codex', async* runTurn() { yield { _tag: 'Message', text: 'Partial response' } } },
    prepared: async () => {},
    emit: async () => {},
  })).rejects.toThrow('complete')
  const result = await executeDesktopSessionTurn({
    turn,
    home,
    signal,
    provider: { name: 'codex', async* runTurn(request) {
      expect(request.sessionId).toBe('saved-native-session')
      expect(request.workspace).toBe(workspace)
      expect(request.outputSchema).toBeUndefined()
      yield { _tag: 'SessionStarted', sessionId: 'saved-native-session' }
      yield { _tag: 'Message', text: 'Done. {This is plain text.}' }
      yield { _tag: 'TurnCompleted' }
    } },
    prepared: async () => {},
    emit: async (event) => { events.push(event) },
  })
  expect(result).toEqual({ workspacePath: workspace, providerSessionId: 'saved-native-session' })
  expect(events).toContainEqual({ _tag: 'Message', text: 'Done. {This is plain text.}' })
})
