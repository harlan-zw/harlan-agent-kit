import type { WebAuthnCredential } from '@simplewebauthn/server'
import { randomBytes } from 'node:crypto'
import { closeSync, constants, lstatSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface BrowserCredential {
  id: string
  label: string
  credential: WebAuthnCredential
  created: number
}
export interface BrowserChallenge {
  hash: string
  challenge: string
  ceremony: 'registration' | 'authentication'
  sessionHash: string | null
  origin: string
  rpId: string
  expires: number
}
export interface BrowserSession {
  hash: string
  credentialId: string | null
  expires: number
}

/** Each browser authority has its own private database. Tokens are never stored. */
export function openBrowserAuthStore(path: string) {
  const parent = lstatSync(dirname(path))
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0)
    throw new Error('Browser authentication requires a private directory')
  const descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  closeSync(descriptor)
  const file = lstatSync(path)
  if (!file.isFile() || file.uid !== process.getuid?.() || file.nlink !== 1 || (file.mode & 0o077) !== 0)
    throw new Error('Browser authentication requires a private file')
  const database = new DatabaseSync(path)
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK(id=1), user_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, label TEXT NOT NULL, credential TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS challenges (hash TEXT PRIMARY KEY, challenge TEXT NOT NULL, ceremony TEXT NOT NULL, session_hash TEXT, origin TEXT NOT NULL, rp_id TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, credential_id TEXT, expires INTEGER NOT NULL);`)
  database.prepare('INSERT OR IGNORE INTO account VALUES (1, ?)').run(randomBytes(32).toString('base64url'))
  function credentials(): BrowserCredential[] {
    return database
      .prepare('SELECT * FROM credentials ORDER BY created')
      .all()
      .map((row) => ({
        id: String(row.id),
        label: String(row.label),
        credential: {
          ...JSON.parse(String(row.credential)),
          publicKey: Buffer.from(JSON.parse(String(row.credential)).publicKey, 'base64url'),
        },
        created: Number(row.created),
      }))
  }
  return {
    userId: Buffer.from(String(database.prepare('SELECT user_id FROM account WHERE id=1').get()!.user_id), 'base64url'),
    credentials,
    credential(id: string) {
      return credentials().find((item) => item.id === id)
    },
    addCredential(value: BrowserCredential) {
      if (credentials().length >= 20) return false
      return (
        database.prepare('INSERT OR IGNORE INTO credentials VALUES (?, ?, ?, ?)').run(
          value.id,
          value.label,
          JSON.stringify({
            ...value.credential,
            publicKey: Buffer.from(value.credential.publicKey).toString('base64url'),
          }),
          value.created,
        ).changes === 1
      )
    },
    updateCounter(id: string, before: number, after: number) {
      const value = credentials().find((item) => item.id === id)
      if (!value || value.credential.counter !== before) return false
      return (
        database.prepare('UPDATE credentials SET credential=? WHERE id=? AND credential=?').run(
          JSON.stringify({
            ...value.credential,
            counter: after,
            publicKey: Buffer.from(value.credential.publicKey).toString('base64url'),
          }),
          id,
          JSON.stringify({
            ...value.credential,
            publicKey: Buffer.from(value.credential.publicKey).toString('base64url'),
          }),
        ).changes === 1
      )
    },
    removeCredential(id: string, minimumRemaining = 0) {
      database.exec('BEGIN IMMEDIATE')
      try {
        if (
          !database.prepare('SELECT id FROM credentials WHERE id=?').get(id) ||
          Number(database.prepare('SELECT count(*) AS count FROM credentials').get()!.count) <= minimumRemaining
        ) {
          database.exec('ROLLBACK')
          return false
        }
        database.prepare('DELETE FROM sessions WHERE credential_id=?').run(id)
        const removed = database.prepare('DELETE FROM credentials WHERE id=?').run(id).changes === 1
        database.exec('COMMIT')
        return removed
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
    challenge(value: BrowserChallenge) {
      database.prepare('DELETE FROM challenges WHERE expires<=?').run(value.expires - 300000)
      if (Number(database.prepare('SELECT count(*) AS count FROM challenges').get()!.count) >= 256) return false
      database
        .prepare('INSERT INTO challenges VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(value.hash, value.challenge, value.ceremony, value.sessionHash, value.origin, value.rpId, value.expires)
      return true
    },
    consume(
      hash: string,
      ceremony: BrowserChallenge['ceremony'],
      sessionHash: string | null,
      now: number,
    ): BrowserChallenge | null {
      const row = database
        .prepare('DELETE FROM challenges WHERE hash=? AND ceremony=? AND session_hash IS ? AND expires>? RETURNING *')
        .get(hash, ceremony, sessionHash, now)
      return row
        ? {
            hash: String(row.hash),
            challenge: String(row.challenge),
            ceremony,
            sessionHash,
            origin: String(row.origin),
            rpId: String(row.rp_id),
            expires: Number(row.expires),
          }
        : null
    },
    session(value: BrowserSession) {
      database.prepare('DELETE FROM sessions WHERE expires<=?').run(value.expires - 2592000000)
      database.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(value.hash, value.credentialId, value.expires)
    },
    sessionByHash(hash: string, now: number): BrowserSession | null {
      const row = database.prepare('SELECT * FROM sessions WHERE hash=? AND expires>?').get(hash, now)
      return row
        ? {
            hash,
            credentialId: row.credential_id === null ? null : String(row.credential_id),
            expires: Number(row.expires),
          }
        : null
    },
    revokeSession(hash: string) {
      database.prepare('DELETE FROM sessions WHERE hash=?').run(hash)
    },
    sessionsForCredential(id: string) {
      return database
        .prepare('SELECT hash FROM sessions WHERE credential_id=?')
        .all(id)
        .map((row) => String(row.hash))
    },
    close() {
      database.close()
    },
  }
}
export type BrowserAuthStore = ReturnType<typeof openBrowserAuthStore>
