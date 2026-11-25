import type { DatabaseSync } from 'node:sqlite'
import type { HandoffQuery, RepositoryHandoff } from './repository-handoff-types.ts'
import { isDeepStrictEqual } from 'node:util'

export const repositoryHandoffSchema = `
  CREATE TABLE IF NOT EXISTS repository_handoffs (
    id INTEGER PRIMARY KEY,
    repository TEXT NOT NULL,
    request_id TEXT NOT NULL,
    sender_key TEXT NOT NULL,
    content TEXT NOT NULL CHECK (json_valid(content)),
    created_at TEXT NOT NULL,
    UNIQUE (repository, sender_key, request_id)
  );
  CREATE INDEX IF NOT EXISTS repository_handoffs_by_repository
    ON repository_handoffs (repository, id);
`

type HandoffContent = Pick<RepositoryHandoff, 'sender' | 'message' | 'item' | 'replyTo'>
interface HandoffRow { id: number, repository: string, content: string, created_at: string }

export type HandoffPostResult
  = | { _tag: 'Posted', handoff: RepositoryHandoff, inserted: boolean }
    | { _tag: 'RequestConflict' }

function decode(row: HandoffRow): RepositoryHandoff {
  return { id: row.id, repository: row.repository, createdAt: row.created_at, ...JSON.parse(row.content) as HandoffContent }
}

export function createRepositoryHandoffStore(database: DatabaseSync) {
  const find = database.prepare('SELECT * FROM repository_handoffs WHERE repository = ? AND id = ?')
  const recent = database.prepare('SELECT * FROM repository_handoffs WHERE repository = ? ORDER BY id DESC LIMIT ?')
  const since = database.prepare('SELECT * FROM repository_handoffs WHERE repository = ? AND id > ? ORDER BY id LIMIT ?')
  const byRequest = database.prepare('SELECT * FROM repository_handoffs WHERE repository = ? AND sender_key = ? AND request_id = ?')
  const append = database.prepare(`
    INSERT INTO repository_handoffs (repository, sender_key, request_id, content, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (repository, sender_key, request_id) DO NOTHING
    RETURNING *
  `)

  return {
    findHandoff(repository: string, id: number): RepositoryHandoff | null {
      const row = find.get(repository, id) as HandoffRow | undefined
      return row === undefined ? null : decode(row)
    },
    listHandoffs(query: HandoffQuery): RepositoryHandoff[] {
      const limit = query.limit ?? 20
      const rows = query.after === undefined
        ? recent.all(query.repository, limit).reverse()
        : since.all(query.repository, query.after, limit)
      return (rows as unknown as HandoffRow[]).map(decode)
    },
    appendHandoff(repository: string, requestId: string, content: HandoffContent, at: string): HandoffPostResult {
      const senderKey = content.sender._tag === 'Control' ? `control:${content.sender.agent}` : `task:${content.sender.taskId}`
      const inserted = append.get(repository, senderKey, requestId, JSON.stringify(content), at) as HandoffRow | undefined
      if (inserted !== undefined)
        return { _tag: 'Posted', handoff: decode(inserted), inserted: true }
      const prior = byRequest.get(repository, senderKey, requestId) as HandoffRow | undefined
      if (prior === undefined)
        throw new Error('The Journal could not read the existing Handoff.')
      return isDeepStrictEqual(JSON.parse(prior.content), content)
        ? { _tag: 'Posted', handoff: decode(prior), inserted: false }
        : { _tag: 'RequestConflict' }
    },
  }
}

export type RepositoryHandoffStore = ReturnType<typeof createRepositoryHandoffStore>
