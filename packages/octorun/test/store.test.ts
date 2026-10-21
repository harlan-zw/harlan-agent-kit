import type { EventEnvelope } from '../src/index.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openStore, restoreStoreBackup } from '../src/index.ts'

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
    expect(store.paused('acme/project', '1:pull_request:5')).toBe(false)
    expect(store.operatorPaused()).toBe(false)
    store.setOperatorPause(true)
    expect(store.operatorPaused()).toBe(true)
    store.close()
  })
})
