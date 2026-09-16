import type { AgentEvent } from '../src/agent-provider.ts'
import type { DesktopTurn } from '../src/desktop-broker.ts'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createDesktopBroker } from '../src/desktop-broker.ts'
import { executeDesktopTurn } from '../src/desktop-execute.ts'
import { DESKTOP_PROTOCOL } from '../src/desktop-protocol.ts'
import { applyDesktopFiles, DESKTOP_WORKTREE_LIMITS, desktopCommand, desktopHistoryBundle, desktopRepositoryPath, desktopWorktreeRefusal, exportDesktopWorktree, importDesktopWorktree, prepareDesktopWorktree } from '../src/desktop-worktree.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-worktree-test-'))
  directories.push(root)
  const repository = join(root, 'repository')
  await mkdir(repository)
  const git = (args: string[]) => desktopCommand('git', ['-c', 'core.hooksPath=/dev/null', ...args], repository)
  await git(['init', '-b', 'main'])
  await git(['config', 'user.name', 'Agent test'])
  await git(['config', 'user.email', 'agent@example.invalid'])
  await writeFile(join(repository, 'file.txt'), 'original\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'test: seed'])
  await git(['remote', 'add', 'origin', 'https://github.com/harlan-zw/example.git'])
  const transfer = join(root, 'transfer')
  await mkdir(transfer)
  return { root, repository, git, transfer }
}

/**
 * A checkout with a reachable origin, as every real repository has.
 *
 * `fixture` deliberately has no origin refs, so it exercises the whole-history
 * fallback. This one exercises the ordinary path, where the two hosts share a
 * remote and only local work travels.
 */
async function sharedFixture() {
  const f = await fixture()
  const origin = join(f.root, 'origin.git')
  await desktopCommand('git', ['init', '--bare', '-b', 'main', origin], f.root)
  await f.git(['remote', 'set-url', 'origin', origin])
  await f.git(['push', 'origin', 'main'])
  await f.git(['fetch', 'origin'])
  return { ...f, origin }
}

it('round trips committed changes, binary edits, and untracked files into the owned Worktree', async () => {
  const f = await fixture()
  const initial = await exportDesktopWorktree(f.repository, f.transfer)
  await writeFile(join(f.repository, 'file.txt'), 'committed\n')
  await f.git(['add', '.'])
  await f.git(['commit', '-m', 'fix: update'])
  await writeFile(join(f.repository, 'file.txt'), 'edited again\n')
  await writeFile(join(f.repository, 'asset.bin'), Buffer.from([0, 255, 1]))
  const changed = await exportDesktopWorktree(f.repository, f.transfer)
  await f.git(['reset', '--hard', initial.head])
  await rm(join(f.repository, 'asset.bin'))
  await importDesktopWorktree(f.repository, initial, changed, f.transfer)
  expect(await f.git(['rev-parse', 'HEAD'])).toBe(changed.head)
  expect(await readFile(join(f.repository, 'file.txt'), 'utf8')).toBe('edited again\n')
  expect(await readFile(join(f.repository, 'asset.bin'))).toEqual(Buffer.from([0, 255, 1]))
})

it('refuses a result after the controller Worktree changed', async () => {
  const f = await fixture()
  const initial = await exportDesktopWorktree(f.repository, f.transfer)
  await writeFile(join(f.repository, 'file.txt'), 'another task changed this\n')
  await expect(importDesktopWorktree(f.repository, initial, initial, f.transfer)).rejects.toThrow('changed during desktop execution')
  expect(await readFile(join(f.repository, 'file.txt'), 'utf8')).toBe('another task changed this\n')
})

it('refuses file paths outside the Worktree or inside Git metadata', async () => {
  const f = await fixture()
  const initial = await exportDesktopWorktree(f.repository, f.transfer)
  for (const path of ['../outside', '.git/config', '/tmp/outside'])
    await expect(applyDesktopFiles(f.repository, { ...initial, files: [{ path, data: 'dGVzdA==', mode: 0o600 }] }, f.transfer)).rejects.toThrow('outside the Worktree')
})

it('prepares a real Worktrunk checkout from the transferred commit', async () => {
  const f = await fixture()
  const initial = await exportDesktopWorktree(f.repository, f.transfer)
  const workspace = await prepareDesktopWorktree(initial, join(f.root, 'desktop'), join(f.root, 'desktop-transfer'))
  expect(await desktopCommand('git', ['rev-parse', 'HEAD'], workspace)).toBe(initial.head)
  expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('original\n')
})

it('imports one desktop result and rejects late duplicate completion', async () => {
  const f = await fixture()
  const broker = createDesktopBroker({ now: () => 1 })
  broker.report({ protocol: DESKTOP_PROTOCOL, memoryGiB: 16, reservedGiB: 0, agents: 0, actions: 0 })
  const iterator = broker.provider('codex').runTurn({ model: 'test', outputSchema: {}, prompt: 'test', sessionId: null, signal: new AbortController().signal, workspace: f.repository })[Symbol.asyncIterator]()
  const response = iterator.next()
  let turn: ReturnType<typeof broker.claim> = null
  await vi.waitFor(() => {
    turn = broker.claim()
    expect(turn).not.toBeNull()
  })
  const claimed = turn as unknown as DesktopTurn
  expect(broker.claim()).toBeNull()
  expect(broker.events(claimed.id, [{ _tag: 'Message', text: 'finished' }])).toBe(true)
  expect(broker.complete(claimed.id, claimed.worktree, null)).toBe(true)
  expect(await response).toEqual({ done: false, value: { _tag: 'Message', text: 'finished' } })
  expect((await iterator.next()).done).toBe(true)
  expect(broker.complete(claimed.id, claimed.worktree, null)).toBe(false)
})

it('revokes cancelled desktop work before accepting another result', async () => {
  const f = await fixture()
  const broker = createDesktopBroker({ now: () => 1 })
  broker.report({ protocol: DESKTOP_PROTOCOL, memoryGiB: 16, reservedGiB: 0, agents: 0, actions: 0 })
  const signal = new AbortController()
  const iterator = broker.provider('codex').runTurn({ model: 'test', outputSchema: {}, prompt: 'test', sessionId: null, signal: signal.signal, workspace: f.repository })[Symbol.asyncIterator]()
  const response = iterator.next()
  const rejected = expect(response).rejects.toThrow()
  let turn: ReturnType<typeof broker.claim> = null
  await vi.waitFor(() => {
    turn = broker.claim()
    expect(turn).not.toBeNull()
  })
  const claimed = turn as unknown as DesktopTurn
  signal.abort()
  await rejected
  expect(broker.active(claimed.id)).toBe(false)
  expect(broker.complete(claimed.id, claimed.worktree, null)).toBe(false)
})

it('keeps pending memory settings across controller restarts', async () => {
  const f = await fixture()
  const settingsPath = join(f.root, 'capacity.json')
  createDesktopBroker({ now: () => 0, settingsPath }).setMemory(20)
  const next = createDesktopBroker({ now: () => 0, settingsPath })
  expect(next.report({ protocol: DESKTOP_PROTOCOL, memoryGiB: 16, reservedGiB: 0, agents: 0, actions: 0 })).toEqual({ memoryGiB: 20 })
  next.report({ protocol: DESKTOP_PROTOCOL, memoryGiB: 20, reservedGiB: 0, agents: 0, actions: 0 })
  expect(createDesktopBroker({ now: () => 0, settingsPath }).read().requestedMemoryGiB).toBeNull()
})

it('executes desktop work and maps returned paths back to the controller', async () => {
  const f = await fixture()
  const initial = await exportDesktopWorktree(f.repository, f.transfer)
  const events: AgentEvent[] = []
  const result = await executeDesktopTurn({
    turn: { id: 'test', provider: 'codex', request: { model: 'test', outputSchema: {}, prompt: `Work in ${f.repository}`, workspace: f.repository, sessionId: null }, worktree: initial },
    directory: join(f.root, 'execution'),
    repositories: join(f.root, 'repositories'),
    signal: new AbortController().signal,
    emit: event => events.push(event),
    provider: { name: 'codex', async* runTurn(request) {
      expect(request.workspace).not.toBe(f.repository)
      expect(request.prompt).toBe(`Work in ${request.workspace}`)
      await writeFile(join(request.workspace, 'result.txt'), 'desktop result\n')
      yield { _tag: 'Message', text: JSON.stringify({ path: join(request.workspace, 'result.txt') }) }
    } },
  })
  await importDesktopWorktree(f.repository, initial, result, f.transfer)
  expect(await readFile(join(f.repository, 'result.txt'), 'utf8')).toBe('desktop result\n')
  expect(events).toContainEqual({ _tag: 'Message', text: JSON.stringify({ path: join(f.repository, 'result.txt') }) })
})

it('refuses a result after an untracked controller file changes', async () => {
  const f = await fixture()
  await writeFile(join(f.repository, 'notes.txt'), 'first\n')
  const initial = await exportDesktopWorktree(f.repository, f.transfer)
  await writeFile(join(f.repository, 'notes.txt'), 'keep this edit\n')
  await expect(importDesktopWorktree(f.repository, initial, initial, f.transfer)).rejects.toThrow('changed during desktop execution')
  expect(await readFile(join(f.repository, 'notes.txt'), 'utf8')).toBe('keep this edit\n')
})

it('transfers ignored pull request diagrams required for publication', async () => {
  const f = await fixture()
  await writeFile(join(f.repository, '.gitignore'), '.pr-lens/\n')
  await mkdir(join(f.repository, '.pr-lens'))
  await writeFile(join(f.repository, '.pr-lens/overview.svg'), '<svg/>')
  const result = await exportDesktopWorktree(f.repository, f.transfer)
  expect(result.files.find(file => file.path === '.pr-lens/overview.svg')?.data).toBe(Buffer.from('<svg/>').toString('base64'))
})

it('keeps an input file when the desktop commits it', async () => {
  const f = await fixture()
  await writeFile(join(f.repository, 'new.txt'), 'keep committed file\n')
  const initial = await exportDesktopWorktree(f.repository, f.transfer)
  await f.git(['add', 'new.txt'])
  await f.git(['commit', '-m', 'feat: add file'])
  const result = await exportDesktopWorktree(f.repository, f.transfer)
  await f.git(['reset', '--hard', initial.head])
  await writeFile(join(f.repository, 'new.txt'), 'keep committed file\n')
  await importDesktopWorktree(f.repository, initial, result, f.transfer)
  expect(await readFile(join(f.repository, 'new.txt'), 'utf8')).toBe('keep committed file\n')
})

it('refuses to export a Worktree the desktop cannot carry', async () => {
  const f = await fixture()
  await writeFile(join(f.repository, 'notes.txt'), 'untracked\n')
  const limits = { ...DESKTOP_WORKTREE_LIMITS, bundle: 16 }

  await expect(exportDesktopWorktree(f.repository, f.transfer, { limits }))
    .rejects
    .toThrow(/^The desktop cannot run a turn for .+\. Its history is \d+ KiB, and the limit is 1 KiB\.$/)
  await expect(exportDesktopWorktree(f.repository, f.transfer, { limits: DESKTOP_WORKTREE_LIMITS })).resolves.toBeDefined()
})

it('names every part that keeps a Worktree on Hogwild', () => {
  const worktree = { head: 'a'.repeat(40), origin: 'https://github.com/harlan-zw/example', history: { _tag: 'Whole' as const, bundle: 'bundle' }, patch: 'patch', files: [{ path: 'notes.txt', data: 'ZGF0YQ==', mode: 0o644 }] }
  expect(desktopWorktreeRefusal(worktree)).toBeNull()
  expect(desktopWorktreeRefusal(worktree, { bundle: 1, patch: 8, file: 8, files: 8 })).toMatch(/^Its history is /)
  expect(desktopWorktreeRefusal(worktree, { bundle: 8, patch: 1, file: 8, files: 8 })).toMatch(/^Its uncommitted change is /)
  expect(desktopWorktreeRefusal(worktree, { bundle: 8, patch: 8, file: 8, files: 0 })).toBe('Its untracked file count is 1, and the limit is 0.')
  expect(desktopWorktreeRefusal(worktree, { bundle: 8, patch: 8, file: 1, files: 8 })).toMatch(/^Its untracked file notes\.txt is /)
})

it('carries nothing when origin already holds the commit', async () => {
  const f = await sharedFixture()

  const exported = await exportDesktopWorktree(f.repository, f.transfer)

  expect(exported.history).toEqual({ _tag: 'Held' })
})

it('carries only the commits origin does not have', async () => {
  const f = await sharedFixture()
  await writeFile(join(f.repository, 'file.txt'), 'local work\n')
  await f.git(['commit', '-qam', 'feat: local work'])

  const exported = await exportDesktopWorktree(f.repository, f.transfer)

  expect(exported.history._tag).toBe('Incremental')
  const carried = join(f.root, 'carried.bundle')
  await writeFile(carried, Buffer.from(desktopHistoryBundle(exported.history), 'base64'))
  // A repository holding nothing cannot use it. That refusal is the saving:
  // every commit origin already has stayed behind.
  const bare = join(f.root, 'bare')
  await desktopCommand('git', ['init', '-q', '--bare', bare], f.root)
  await expect(desktopCommand('git', ['bundle', 'verify', carried], bare)).rejects.toThrow(/prerequisite/i)
})

it('builds the desktop checkout from origin and unbundles only the local work', async () => {
  const f = await sharedFixture()
  await writeFile(join(f.repository, 'file.txt'), 'local work\n')
  await f.git(['commit', '-qam', 'feat: local work'])
  const exported = { ...await exportDesktopWorktree(f.repository, f.transfer), origin: f.origin }

  const workspace = await prepareDesktopWorktree(exported, join(f.root, 'desktop'), join(f.root, 'desktop-transfer'))

  expect(await desktopCommand('git', ['rev-parse', 'HEAD'], workspace)).toBe(exported.head)
  expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('local work\n')
})

it('reuses one control checkout across turns on the same repository', async () => {
  const f = await sharedFixture()
  const cache = join(f.root, 'desktop')
  const first = { ...await exportDesktopWorktree(f.repository, f.transfer), origin: f.origin }
  await prepareDesktopWorktree(first, cache, join(f.root, 'transfer-one'))
  const cloned = await desktopCommand('git', ['rev-parse', '--git-dir'], join(cache, 'control'))
  await writeFile(join(f.repository, 'file.txt'), 'second turn\n')
  await f.git(['commit', '-qam', 'feat: second turn'])
  const second = { ...await exportDesktopWorktree(f.repository, f.transfer), origin: f.origin }

  const workspace = await prepareDesktopWorktree(second, cache, join(f.root, 'transfer-two'))

  expect(await desktopCommand('git', ['rev-parse', '--git-dir'], join(cache, 'control'))).toBe(cloned)
  expect(await desktopCommand('git', ['rev-parse', 'HEAD'], workspace)).toBe(second.head)
  expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('second turn\n')
})

it('sends one turn of work back, not the history the controller already holds', async () => {
  const f = await sharedFixture()
  const initial = await exportDesktopWorktree(f.repository, f.transfer)
  await writeFile(join(f.repository, 'file.txt'), 'desktop work\n')
  await f.git(['commit', '-qam', 'feat: desktop work'])

  const result = await exportDesktopWorktree(f.repository, f.transfer, { against: initial.head })

  expect(result.history._tag).toBe('Incremental')
  await f.git(['reset', '--hard', initial.head])
  await importDesktopWorktree(f.repository, initial, result, f.transfer)
  expect(await desktopCommand('git', ['rev-parse', 'HEAD'], f.repository)).toBe(result.head)
  expect(await readFile(join(f.repository, 'file.txt'), 'utf8')).toBe('desktop work\n')
})

it('refuses a result that names a commit it never sent', async () => {
  const f = await sharedFixture()
  const initial = await exportDesktopWorktree(f.repository, f.transfer)

  const forged = { ...initial, head: 'b'.repeat(40), history: { _tag: 'Held' as const } }

  await expect(importDesktopWorktree(f.repository, initial, forged, f.transfer)).rejects.toThrow('names a commit it did not send')
})

it('separates repositories that share a name across owners', () => {
  expect(desktopRepositoryPath('/cache', 'https://github.com/harlan-zw/example.git')).toBe('/cache/harlan-zw/example')
  expect(desktopRepositoryPath('/cache', 'git@github.com:skilld-dev/example')).toBe('/cache/skilld-dev/example')
  expect(() => desktopRepositoryPath('/cache', '/tmp/repo')).toThrow('not a GitHub repository')
})

it('stands down a desktop running another revision', async () => {
  const f = await fixture()
  const broker = createDesktopBroker({ now: () => 1 })
  broker.report({ protocol: DESKTOP_PROTOCOL - 1, memoryGiB: 16, reservedGiB: 0, agents: 0, actions: 0 })

  expect(broker.read().connected).toBe(true)
  expect(broker.read().current).toBe(false)
  expect(broker.available()).toBe(false)

  const iterator = broker.provider('codex').runTurn({ model: 'test', outputSchema: {}, prompt: 'test', sessionId: null, signal: new AbortController().signal, workspace: f.repository })[Symbol.asyncIterator]()
  const response = iterator.next()
  await vi.waitFor(() => expect(broker.read().report?.protocol).toBe(DESKTOP_PROTOCOL - 1))
  expect(broker.claim()).toBeNull()

  // The same desktop, once it catches up, takes the turn already waiting.
  broker.report({ protocol: DESKTOP_PROTOCOL, memoryGiB: 16, reservedGiB: 0, agents: 0, actions: 0 })
  let turn: ReturnType<typeof broker.claim> = null
  await vi.waitFor(() => {
    turn = broker.claim()
    expect(turn).not.toBeNull()
  })
  const claimed = turn as unknown as DesktopTurn
  broker.events(claimed.id, [{ _tag: 'Message', text: 'finished' }])
  broker.complete(claimed.id, claimed.worktree, null)
  expect(await response).toEqual({ done: false, value: { _tag: 'Message', text: 'finished' } })
  await iterator.next()
})
