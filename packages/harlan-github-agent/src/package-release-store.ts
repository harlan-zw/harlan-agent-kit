import type { DatabaseSync } from 'node:sqlite'
import type { PackageReleaseCommand, PackageReleasePlan, PackageReleaseRequest, ReleaseNoteApproval } from './package-release.ts'
import { createHash } from 'node:crypto'

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

/** A merged pull request in the release range, as untrusted text for the drafting Agent. */
export interface ReleaseNotePullRequest {
  number: number
  title: string
  body: string
}

/** One published version and the evidence its Release note draft starts from. */
export interface ReleaseNoteSubject {
  repository: string
  /** The pull request whose release comment shows the draft. */
  pullRequestNumber: number
  packageName: string
  version: string
  tag: string
  previousTag: string
  /** The published commit. */
  sha: string
  /** A failed read leaves the draft to the git range alone. It never holds the release. */
  pullRequests: { _tag: 'Available', entries: ReleaseNotePullRequest[] } | { _tag: 'Unavailable', reason: string }
}

export type ReleaseNoteState
  = | { _tag: 'Queued' }
    | { _tag: 'Running', fence: number, workerId: string, leaseExpiresAt: string }
    | { _tag: 'Drafted', text: string }
    | { _tag: 'Approved', text: string, requestedBy: string }
    | { _tag: 'Applied', text: string, url: string }
    | { _tag: 'ApplyFailed', text: string, reason: string }
    | { _tag: 'Failed', reason: string }

export interface ReleaseNote extends ReleaseNoteSubject {
  id: string
  attempts: number
  state: ReleaseNoteState
}

export type ClaimedReleaseNote = ReleaseNote & { state: Extract<ReleaseNoteState, { _tag: 'Running' }> }

/** A draft is optional. After three attempts it stops, and the release stays published. */
const MAXIMUM_RELEASE_NOTE_ATTEMPTS = 3

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
    CREATE TABLE IF NOT EXISTS package_release_notes (
      id TEXT PRIMARY KEY, repository TEXT NOT NULL, version TEXT NOT NULL, subject TEXT NOT NULL,
      state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, UNIQUE(repository, version)
    );
  `)
  interface ReleaseNoteRow { id: string, subject: string, state: string, attempts: number }
  const releaseNote = (row: ReleaseNoteRow): ReleaseNote => ({ ...JSON.parse(row.subject) as ReleaseNoteSubject, id: row.id, attempts: row.attempts, state: JSON.parse(row.state) as ReleaseNoteState })
  /** Writes only for the worker that holds the current fence. A stale worker changes nothing. */
  const settleReleaseNote = (owner: { taskId: string, workerId: string, fence: number }, state: ReleaseNoteState): boolean =>
    database.prepare(`UPDATE package_release_notes SET state=? WHERE id=?
      AND json_extract(state, '$._tag')='Running' AND json_extract(state, '$.workerId')=? AND json_extract(state, '$.fence')=?
    `).run(JSON.stringify(state), owner.taskId, owner.workerId, owner.fence).changes === 1
  const transaction = <T>(work: () => T): T => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const value = work()
      database.exec('COMMIT')
      return value
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
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
    /** Returns false when this version already has a draft. A replayed publish pass queues nothing new. */
    queueReleaseNote(subject: ReleaseNoteSubject): boolean {
      const id = createHash('sha256').update(`${subject.repository}\n${subject.version}`).digest('hex')
      return database.prepare('INSERT OR IGNORE INTO package_release_notes(id, repository, version, subject, state) VALUES (?, ?, ?, ?, ?)')
        .run(id, subject.repository, subject.version, JSON.stringify(subject), JSON.stringify({ _tag: 'Queued' }))
        .changes === 1
    },
    getReleaseNote(repository: string, version: string): ReleaseNote | null {
      const row = database.prepare('SELECT id, subject, state, attempts FROM package_release_notes WHERE repository=? AND version=?')
        .get(repository, version) as ReleaseNoteRow | undefined
      return row === undefined ? null : releaseNote(row)
    },
    /** Claims queued work, or work whose lease expired after a lost worker. Each claim spends one attempt. */
    claimNextReleaseNote(workerId: string, at: string, leaseMilliseconds: number): ClaimedReleaseNote | null {
      return transaction(() => {
        const rows = database.prepare(`SELECT id, subject, state, attempts FROM package_release_notes
          WHERE json_extract(state, '$._tag')='Queued'
          OR (json_extract(state, '$._tag')='Running' AND json_extract(state, '$.leaseExpiresAt') <= ?)
          ORDER BY rowid`).all(at) as unknown as ReleaseNoteRow[]
        for (const row of rows) {
          if (row.attempts >= MAXIMUM_RELEASE_NOTE_ATTEMPTS) {
            database.prepare('UPDATE package_release_notes SET state=? WHERE id=?')
              .run(JSON.stringify({ _tag: 'Failed', reason: 'The draft stopped after three attempts.' }), row.id)
            continue
          }
          // The attempt count is the fence. Every claim raises it, so a stale worker cannot settle.
          const attempts = row.attempts + 1
          const state = { _tag: 'Running' as const, fence: attempts, workerId, leaseExpiresAt: new Date(Date.parse(at) + leaseMilliseconds).toISOString() }
          database.prepare('UPDATE package_release_notes SET state=?, attempts=? WHERE id=?').run(JSON.stringify(state), attempts, row.id)
          return { ...releaseNote(row), attempts, state }
        }
        return null
      })
    },
    heartbeatReleaseNote(input: { taskId: string, workerId: string, fence: number, at: string, leaseMilliseconds: number }): boolean {
      return database.prepare(`UPDATE package_release_notes SET state=json_set(state, '$.leaseExpiresAt', ?) WHERE id=?
        AND json_extract(state, '$._tag')='Running' AND json_extract(state, '$.workerId')=? AND json_extract(state, '$.fence')=?
        AND json_extract(state, '$.leaseExpiresAt') > ?
      `).run(new Date(Date.parse(input.at) + input.leaseMilliseconds).toISOString(), input.taskId, input.workerId, input.fence, input.at).changes === 1
    },
    completeReleaseNote(input: { taskId: string, workerId: string, fence: number, at: string, notes: string }): boolean {
      return settleReleaseNote(input, { _tag: 'Drafted', text: input.notes })
    },
    failReleaseNote(input: { taskId: string, workerId: string, fence: number, at: string, reason: string }): 'Retrying' | 'Failed' | 'Rejected' {
      return transaction(() => {
        const row = database.prepare('SELECT attempts FROM package_release_notes WHERE id=?').get(input.taskId) as { attempts: number } | undefined
        if (row === undefined)
          return 'Rejected'
        if (row.attempts < MAXIMUM_RELEASE_NOTE_ATTEMPTS)
          return settleReleaseNote(input, { _tag: 'Queued' }) ? 'Retrying' : 'Rejected'
        return settleReleaseNote(input, { _tag: 'Failed', reason: input.reason }) ? 'Failed' : 'Rejected'
      })
    },
    /**
     * Binds Harlan's tick to the exact comment that showed the draft.
     * A stale comment, a replayed delivery, or a draft in any other state changes nothing.
     */
    approveReleaseNote(input: ReleaseNoteApproval & { requestId: string }): boolean {
      return transaction(() => {
        const fresh = database.prepare('INSERT OR IGNORE INTO package_release_requests VALUES (?, ?)')
          .run(input.repository, input.requestId)
          .changes === 1
        return fresh && database.prepare(`UPDATE package_release_notes
          SET state=json_object('_tag', 'Approved', 'text', json_extract(state, '$.text'), 'requestedBy', ?)
          WHERE repository=? AND json_extract(state, '$._tag')='Drafted' AND json_extract(subject, '$.pullRequestNumber')=?
          AND EXISTS (SELECT 1 FROM package_releases AS release WHERE release.repository=package_release_notes.repository
            AND release.pull_request_number=? AND release.comment_id=? AND release.body=?
            AND json_extract(release.plan, '$.version')=package_release_notes.version
            AND json_extract(release.state, '$._tag')='Completed')
        `).run(input.requestedBy, input.repository, input.pullRequestNumber, input.pullRequestNumber, input.commentId, input.before).changes === 1
      })
    },
    /** Records the edited GitHub release while the controller holds the release lease. */
    markReleaseNoteApplied(input: { repository: string, version: string, url: string }, fence: number, now: number): boolean {
      return database.prepare(`UPDATE package_release_notes
        SET state=json_object('_tag', 'Applied', 'text', json_extract(state, '$.text'), 'url', ?)
        WHERE repository=? AND version=? AND json_extract(state, '$._tag')='Approved'
        AND EXISTS (SELECT 1 FROM package_release_leases WHERE repository=? AND fence=? AND expires_at>?)
      `).run(input.url, input.repository, input.version, input.repository, fence, now).changes === 1
    },
    /** Settles an edit GitHub refused, so the pass stops retrying it. */
    failReleaseNoteApply(input: { repository: string, version: string, reason: string }, fence: number, now: number): boolean {
      return database.prepare(`UPDATE package_release_notes
        SET state=json_object('_tag', 'ApplyFailed', 'text', json_extract(state, '$.text'), 'reason', ?)
        WHERE repository=? AND version=? AND json_extract(state, '$._tag')='Approved'
        AND EXISTS (SELECT 1 FROM package_release_leases WHERE repository=? AND fence=? AND expires_at>?)
      `).run(input.reason, input.repository, input.version, input.repository, fence, now).changes === 1
    },
  }
}
