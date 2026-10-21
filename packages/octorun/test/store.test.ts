import type { EventEnvelope } from '../src/index.ts'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createRunner, ok, openStore, parseWorkflow, restoreStoreBackup } from '../src/index.ts'

const event = (id = 'one'): EventEnvelope => ({ id, semanticKey: id, source: 'webhook', name: 'pull_request', action: 'opened', repository: { id: 1, fullName: 'acme/project', installationId: 2 }, actor: null, target: { _tag: 'PullRequest', number: 4, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }, occurredAt: '2026-10-21T00:00:00.000Z', receivedAt: '2026-10-21T00:00:00.000Z', data: {} })

describe('durable workflow storage', () => {
  it('deduplicates a delivery and refuses request ID reuse with different data', () => {
    const store = openStore({ path: ':memory:' })
    expect(store.recordEvent(event())).toEqual({ _tag: 'Ok', value: { eventId: 'one', duplicate: false } })
    expect(store.recordEvent({ ...event(), receivedAt: '2026-10-21T00:00:02.000Z' })).toEqual({ _tag: 'Ok', value: { eventId: 'one', duplicate: true } })
    expect(store.recordEvent({ ...event(), data: { changed: true } })).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
    store.close()
  })

  it('rolls back an interrupted transaction and preserves its original failure', () => {
    const store = openStore({ path: ':memory:' })
    expect(() => store.transaction(() => {
      store.recordEvent(event())
      throw new Error('interrupted')
    })).toThrow('interrupted')
    expect(store.event('one')).toBeNull()
    store.close()
  })

  it('persists accepted events and poll cursors across restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'octorun-store-'))
    const path = join(directory, 'state.sqlite')
    const first = openStore({ path })
    first.recordEvent(event())
    first.setCursor('comments', { watermark: '2026-10-21T00:00:00Z' })
    first.close()
    const second = openStore({ path })
    expect(second.event('one')?.semanticKey).toBe('one')
    expect(second.cursor('comments')).toEqual({ watermark: '2026-10-21T00:00:00Z' })
    second.close()
    await rm(directory, { recursive: true })
  })

  it('prevents a second controller from opening the same state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'octorun-lock-'))
    const path = join(directory, 'state.sqlite')
    const first = openStore({ path })
    expect(() => openStore({ path })).toThrow(/controller|lock/i)
    first.close()
    const second = openStore({ path })
    second.close()
    await rm(directory, { recursive: true })
  })

  it('backs up a live database and restores consistent accepted work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'octorun-backup-'))
    const path = join(directory, 'state.sqlite')
    const backup = join(directory, 'backup.sqlite')
    const store = openStore({ path })
    store.recordEvent(event())
    await store.backup(backup)
    store.recordEvent(event('later'))
    store.close()
    await restoreStoreBackup({ source: backup, destination: path })
    const restored = openStore({ path })
    expect(restored.event('one')?.id).toBe('one')
    expect(restored.event('later')).toBeNull()
    restored.close()
    await rm(directory, { recursive: true })
  })

  it('keeps target pause separate from an operator admission pause', () => {
    const store = openStore({ path: ':memory:' })
    store.setPause('acme/project', '1:pull_request:4', true)
    expect(store.paused('acme/project', '1:pull_request:4')).toBe(true)
    expect(store.paused('ACME/Project', '1:pull_request:4')).toBe(true)
    expect(store.paused('acme/project', '1:pull_request:5')).toBe(false)
    expect(store.operatorPaused()).toBe(false)
    store.setOperatorPause(true)
    expect(store.operatorPaused()).toBe(true)
    store.close()
  })

  it('prunes old terminal run payloads while retaining active evidence and deduplication', async () => {
    const store = openStore({ path: ':memory:', now: () => new Date('2026-10-21T00:00:00Z') })
    const parsed = parseWorkflow({ version: 1, id: 'retain', name: 'Retain', on: [{ event: 'pull_request' }], tasks: [{ id: 'snapshot', uses: 'snapshot' }] })
    if (parsed._tag === 'Err')
      throw new Error(parsed.error.message)
    const runner = createRunner({ store, taskTypes: [{ id: 'snapshot', version: '1', capabilities: [], input: value => ok(value as null), output: value => ok(value as null), execute: async () => ({ _tag: 'Succeeded', output: { diff: 'private source text' } }) }], now: () => new Date('2026-10-21T00:00:00Z') })
    const start = (id: string) => runner.start({ event: { ...event(id), data: { private: 'event text' } }, workflow: parsed.value, policy: { enabled: true, capabilities: [], maxConcurrency: 1 }, configuration: { source: 'test', sha: 'a', digest: 'test' } })
    const finished = start('finished')
    if (finished._tag === 'Err')
      throw new Error(finished.error.message)
    await runner.drain()
    const publication = { id: 'old-comment', key: 'summary', runId: finished.value.id, taskId: '__lifecycle', effect: { _tag: 'Comment' as const, repository: 'acme/project', number: 4, namespace: 'review', body: 'private review text' }, state: { _tag: 'Written' as const, receipt: { id: 'remote-comment', url: null, data: {} } }, attempts: 1, createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z' }
    expect(store.enqueueSystem(publication)._tag).toBe('Ok')
    const active = start('active')
    if (active._tag === 'Err')
      throw new Error(active.error.message)
    expect(store.prune({ before: '2026-10-22T00:00:00Z' })).toMatchObject({ runPayloads: 1 })
    expect(store.run(finished.value.id)).toMatchObject({ state: { _tag: 'Succeeded' }, event: { data: null }, tasks: [{ output: null }] })
    expect(store.run(active.value.id)?.event.data).toEqual({ private: 'event text' })
    expect(store.publication(publication.id)?.effect).toMatchObject({ body: '' })
    expect(store.enqueueSystem(publication)).toEqual(ok(publication.id))
    expect(store.recordEvent({ ...event('finished'), data: { private: 'event text' } })).toMatchObject({ _tag: 'Ok', value: { duplicate: true } })
    expect(start('finished')).toMatchObject({ _tag: 'Ok', value: { id: finished.value.id } })
    await runner.close()
  })

  it.each(['missing', 'corrupt'])('releases the restore lock after a %s backup fails', async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'octorun-restore-error-'))
    const path = join(directory, 'state.sqlite')
    const backup = join(directory, 'backup.sqlite')
    const invalid = join(directory, 'invalid.sqlite')
    const initial = openStore({ path })
    initial.recordEvent(event())
    await initial.backup(backup)
    initial.close()
    if (kind === 'corrupt')
      await writeFile(invalid, 'This file is not a SQLite database.')
    await expect(restoreStoreBackup({ source: invalid, destination: path })).rejects.toThrow()
    await restoreStoreBackup({ source: backup, destination: path })
    const restored = openStore({ path })
    expect(restored.event('one')?.id).toBe('one')
    restored.close()
    await rm(directory, { recursive: true })
  })

  it.each(['constructor', 'pragma', 'schema'])('releases state ownership after %s initialization fails', async (stage) => {
    const directory = await mkdtemp(join(tmpdir(), 'octorun-initialize-error-'))
    const path = join(directory, 'state.sqlite')
    if (stage === 'constructor') {
      await mkdir(path)
    }
    else if (stage === 'pragma') {
      await writeFile(path, 'This file is not a SQLite database.')
    }
    else {
      const incompatible = new DatabaseSync(path)
      incompatible.exec('CREATE TABLE runs (id TEXT PRIMARY KEY)')
      incompatible.close()
    }
    expect(() => openStore({ path })).toThrow()
    await rm(path, { recursive: true, force: true })
    await rm(`${path}-wal`, { force: true })
    await rm(`${path}-shm`, { force: true })
    const recovered = openStore({ path })
    expect(recovered.recordEvent(event())).toEqual({ _tag: 'Ok', value: { eventId: 'one', duplicate: false } })
    recovered.close()
    await rm(directory, { recursive: true })
  })

  it('refuses restore while another controller owns the destination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'octorun-live-restore-'))
    const path = join(directory, 'state.sqlite')
    const backup = join(directory, 'backup.sqlite')
    const active = openStore({ path })
    active.recordEvent(event())
    await active.backup(backup)
    await expect(restoreStoreBackup({ source: backup, destination: path })).rejects.toThrow(/controller|lock/i)
    expect(active.recordEvent(event('still-live'))._tag).toBe('Ok')
    active.close()
    await restoreStoreBackup({ source: backup, destination: path })
    const recovered = openStore({ path })
    expect(recovered.event('still-live')).toBeNull()
    recovered.close()
    await rm(directory, { recursive: true })
  })
})
