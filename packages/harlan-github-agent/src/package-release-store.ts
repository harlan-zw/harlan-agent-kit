import type { DatabaseSync } from 'node:sqlite'
import type { PackageReleaseCommand, PackageReleasePlan, PackageReleaseRequest } from './package-release.ts'

export type PackageReleaseState
  = | { _tag: 'Available' }
    | { _tag: 'AwaitingMerge', requestedBy: string }
    | { _tag: 'Queued', requestedBy: string }
    | { _tag: 'Prepared', pullRequestNumber: number, headSha: string, branch: string }
    | { _tag: 'Publishing', tag: string, sha: string }
    | { _tag: 'Completed', url: string }
    | { _tag: 'Blocked', reason: string }

export interface PackageReleaseRecord {
  repository: string
  pullRequestNumber: number
  commentId: number
  body: string
  policy: string
  plan: PackageReleasePlan
  state: PackageReleaseState
}

export type PackageReleaseStore = ReturnType<typeof createPackageReleaseStore>

/** Release offers and Publication commands share the controller's SQLite journal. */
export function createPackageReleaseStore(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS package_release_requests (
      repository TEXT NOT NULL, request_id TEXT NOT NULL, PRIMARY KEY(repository, request_id)
    );
    CREATE TABLE IF NOT EXISTS package_release_commands (
      repository TEXT NOT NULL, comment_id INTEGER NOT NULL, payload TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(repository, comment_id)
    );
    CREATE TABLE IF NOT EXISTS package_releases (
      repository TEXT NOT NULL, pull_request_number INTEGER NOT NULL,
      comment_id INTEGER NOT NULL, body TEXT NOT NULL, policy TEXT NOT NULL,
      plan TEXT NOT NULL, state TEXT NOT NULL,
      PRIMARY KEY (repository, pull_request_number)
    );
    CREATE TABLE IF NOT EXISTS package_release_leases (
      repository TEXT PRIMARY KEY, fence INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
  `)
  const applyReleaseRequest = (input: PackageReleaseRequest): boolean => {
    if (!input.selected) {
      return database.prepare(`UPDATE package_releases SET state='{"_tag":"Available"}', body=?
          WHERE repository=? AND pull_request_number=? AND comment_id=? AND body IN (?, ?, ?)
          AND json_extract(state, '$._tag')='AwaitingMerge'
        `).run(input.before.replace(/^- \[[xX]\] Release /m, '- [ ] Release '), input.repository, input.pullRequestNumber, input.commentId, input.before, input.before.replace(/^- \[[xX]\] Release /m, '- [ ] Release '), input.before.replace(/^- \[X\] Release /m, '- [x] Release ')).changes === 1
    }
    return database.prepare(`UPDATE package_releases SET state=json_object(
          '_tag', CASE WHEN json_extract(plan, '$._tag')='BeforeMerge' THEN 'AwaitingMerge' ELSE 'Queued' END,
          'requestedBy', ?)
        WHERE repository=? AND pull_request_number=? AND comment_id=? AND body=?
        AND json_extract(state, '$._tag')='Available'
        AND (json_extract(plan, '$._tag')='BeforeMerge' OR NOT EXISTS (
          SELECT 1 FROM package_releases AS other WHERE other.repository=?
          AND json_extract(other.state, '$._tag') IN ('Queued','Prepared','Publishing')))
      `).run(input.requestedBy, input.repository, input.pullRequestNumber, input.commentId, input.before, input.repository).changes === 1
  }
  return {
    mayPublishPackageRelease(repository: string): boolean {
      return database.prepare('SELECT 1 FROM repositories WHERE github=? AND enabled=1 AND writes_enabled=1 AND paused=0')
        .get(repository) !== undefined
    },
    queuePackageReleaseCommand(command: PackageReleaseCommand): void {
      database.prepare('INSERT OR IGNORE INTO package_release_commands(repository,comment_id,payload) VALUES(?,?,?)')
        .run(command.repository, command.commentId, JSON.stringify(command))
    },
    listPackageReleaseCommands(repository: string): PackageReleaseCommand[] {
      return (database.prepare('SELECT payload FROM package_release_commands WHERE repository=? AND consumed=0').all(repository) as Array<{ payload: string }>)
        .map(row => JSON.parse(row.payload) as PackageReleaseCommand)
    },
    consumePackageReleaseCommand(command: PackageReleaseCommand): void {
      database.prepare('UPDATE package_release_commands SET consumed=1 WHERE repository=? AND comment_id=?').run(command.repository, command.commentId)
    },
    saveReleaseOffer(input: Omit<PackageReleaseRecord, 'state'>): void {
      database.prepare(`INSERT INTO package_releases VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repository, pull_request_number) DO UPDATE SET
          comment_id=excluded.comment_id, body=excluded.body, policy=excluded.policy, plan=excluded.plan
        WHERE json_extract(package_releases.state, '$._tag') = 'Available'
      `).run(input.repository, input.pullRequestNumber, input.commentId, input.body, input.policy, JSON.stringify(input.plan), JSON.stringify({ _tag: 'Available' }))
    },
    requestPackageRelease(input: PackageReleaseRequest & { requestId: string }): boolean {
      database.exec('BEGIN IMMEDIATE')
      try {
        const fresh = database.prepare('INSERT OR IGNORE INTO package_release_requests VALUES (?, ?)')
          .run(input.repository, input.requestId)
          .changes === 1
        const applied = fresh && applyReleaseRequest(input)
        database.exec('COMMIT')
        return applied
      }
      catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
    listPackageReleases(repository: string): PackageReleaseRecord[] {
      const rows = database.prepare('SELECT * FROM package_releases WHERE repository=?').all(repository) as Array<{
        repository: string
        pull_request_number: number
        comment_id: number
        body: string
        policy: string
        plan: string
        state: string
      }>
      return rows.map(row => ({ repository: row.repository, pullRequestNumber: row.pull_request_number, commentId: row.comment_id, body: row.body, policy: row.policy, plan: JSON.parse(row.plan) as PackageReleasePlan, state: JSON.parse(row.state) as PackageReleaseState }))
    },
    claimPackageReleaseLease(repository: string, now: number): number | null {
      const row = database.prepare(`INSERT INTO package_release_leases VALUES (?, 1, ?)
        ON CONFLICT(repository) DO UPDATE SET fence=fence+1, expires_at=excluded.expires_at
        WHERE package_release_leases.expires_at <= ? RETURNING fence
      `).get(repository, now + 90_000, now) as { fence: number } | undefined
      return row?.fence ?? null
    },
    renewPackageReleaseLease(repository: string, fence: number, now: number): boolean {
      return database.prepare(`UPDATE package_release_leases SET expires_at=? WHERE repository=? AND fence=? AND expires_at>?`)
        .run(now + 90_000, repository, fence, now)
        .changes === 1
    },
    releasePackageReleaseLease(repository: string, fence: number): void {
      database.prepare('UPDATE package_release_leases SET expires_at=0 WHERE repository=? AND fence=?').run(repository, fence)
    },
    recordPackageReleaseComment(input: PackageReleaseRecord, body: string, fence: number, now: number, commentId = input.commentId): boolean {
      return database.prepare(`UPDATE package_releases SET body=?, comment_id=? WHERE repository=? AND pull_request_number=? AND state=?
        AND EXISTS (SELECT 1 FROM package_release_leases WHERE repository=? AND fence=? AND expires_at>?)
      `).run(body, commentId, input.repository, input.pullRequestNumber, JSON.stringify(input.state), input.repository, fence, now).changes === 1
    },
    updatePackageRelease(input: PackageReleaseRecord, state: PackageReleaseState, fence: number, now: number, plan = input.plan): boolean {
      return database.prepare(`UPDATE package_releases SET state=?, plan=? WHERE repository=? AND pull_request_number=? AND state=?
        AND EXISTS (SELECT 1 FROM package_release_leases WHERE repository=? AND fence=? AND expires_at>?)
      `).run(JSON.stringify(state), JSON.stringify(plan), input.repository, input.pullRequestNumber, JSON.stringify(input.state), input.repository, fence, now).changes === 1
    },
  }
}
