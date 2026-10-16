import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readTerminalHistory, writeTerminalHistory } from '../src/terminal-history.ts'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { force: true, recursive: true })
})

it('prunes expired terminal output while retaining live snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-history-test-'))
  directories.push(directory)
  const sessionId = 'session'
  await mkdir(join(directory, 'sessions', sessionId), { recursive: true })
  writeTerminalHistory(directory, sessionId, [
    { id: 'expired', generation: 'generation', expiresAt: 100, lines: ['expired terminal output'] },
    { id: 'live', generation: 'generation', expiresAt: 200, lines: ['live terminal output'] },
  ])

  expect(readTerminalHistory({
    directory,
    sessionId,
    generation: 'generation',
    snapshot: 'expired',
    offset: null,
    limit: 100,
    now: 150,
  })).toEqual({ _tag: 'Expired' })

  const persisted = JSON.parse(
    await readFile(join(directory, 'sessions', sessionId, 'history.json'), 'utf8'),
  ) as { snapshots: Array<{ id: string }> }
  expect(persisted.snapshots).toEqual([{ id: 'live', generation: 'generation', expiresAt: 200, lines: ['live terminal output'] }])
})

it('deletes an archive when every terminal snapshot expires', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-history-test-'))
  directories.push(directory)
  const sessionId = 'session'
  await mkdir(join(directory, 'sessions', sessionId), { recursive: true })
  writeTerminalHistory(directory, sessionId, [
    { id: 'expired', generation: 'generation', expiresAt: 100, lines: ['expired terminal output'] },
  ])

  expect(readTerminalHistory({
    directory,
    sessionId,
    generation: 'generation',
    snapshot: 'expired',
    offset: null,
    limit: 100,
    now: 150,
  })).toEqual({ _tag: 'Expired' })

  await expect(readFile(join(directory, 'sessions', sessionId, 'history.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})
