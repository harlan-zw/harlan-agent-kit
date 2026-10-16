import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface TerminalHistorySnapshot {
  id: string
  generation: string
  expiresAt: number
  lines: string[]
}

function historyPath(directory: string, sessionId: string) {
  return join(directory, 'sessions', sessionId, 'history.json')
}

export function writeTerminalHistory(
  directory: string,
  sessionId: string,
  snapshots: readonly TerminalHistorySnapshot[],
) {
  const path = historyPath(directory, sessionId)
  const temporary = `${path}.${randomUUID()}.tmp`
  const content = JSON.stringify({ snapshots })
  writeFileSync(temporary, content, { mode: 0o600 })
  const file = openSync(temporary, 'r')
  fsyncSync(file)
  closeSync(file)
  renameSync(temporary, path)
  const directoryHandle = openSync(join(path, '..'), 'r')
  fsyncSync(directoryHandle)
  closeSync(directoryHandle)
}

export function readTerminalHistory(options: {
  directory: string
  sessionId: string
  generation: string
  snapshot: string
  offset: number | null
  limit: number
  now: number
}) {
  const content = (() => {
    try {
      return readFileSync(historyPath(options.directory, options.sessionId), 'utf8')
    }
    catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT')
        return null
      throw cause
    }
  })()
  if (!content)
    return { _tag: 'Expired' } as const
  const value = (() => {
    try {
      return JSON.parse(content) as { snapshots?: unknown }
    }
    catch {
      return null
    }
  })()
  if (!value || !Array.isArray(value.snapshots))
    return { _tag: 'Expired' } as const
  const snapshot = value.snapshots.find((candidate): candidate is TerminalHistorySnapshot =>
    typeof candidate === 'object'
    && candidate !== null
    && typeof (candidate as TerminalHistorySnapshot).id === 'string'
    && (candidate as TerminalHistorySnapshot).id === options.snapshot
    && (candidate as TerminalHistorySnapshot).generation === options.generation
    && Number.isSafeInteger((candidate as TerminalHistorySnapshot).expiresAt)
    && (candidate as TerminalHistorySnapshot).expiresAt > options.now
    && Array.isArray((candidate as TerminalHistorySnapshot).lines)
    && (candidate as TerminalHistorySnapshot).lines.length <= 1000
    && (candidate as TerminalHistorySnapshot).lines.every(line => typeof line === 'string'),
  )
  if (!snapshot)
    return { _tag: 'Expired' } as const
  const offset = Math.min(options.offset ?? Math.max(0, snapshot.lines.length - options.limit), snapshot.lines.length)
  return {
    _tag: 'Page' as const,
    snapshot: snapshot.id,
    total: snapshot.lines.length,
    offset,
    lines: snapshot.lines.slice(offset, offset + options.limit),
  }
}
