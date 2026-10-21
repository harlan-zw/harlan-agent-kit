import type { EventEnvelope, JsonValue, PublicationRecord, Result, RunRecord, TaskFailure } from './types.ts'
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { chmod, copyFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { err, ok } from './types.ts'
import { digest } from './workflow.ts'

export interface StoreLog {
  id: number
  at: string
  runId: string | null
  kind: string
  data: JsonValue
}

export interface StoreOptions {
  path: string
  now?: () => Date
}

export interface StoredDelivery {
  id: string
  event: string
  body: string
  receivedAt: string
  state: 'Queued' | 'Processed' | 'Failed'
  attempts: number
  runAfter: string
  error: TaskFailure | null
}

const schemaVersion = 1
const terminalStates = ['Succeeded', 'Failed', 'Cancelled', 'Superseded', 'Skipped']
const json = <T>(value: unknown): T => JSON.parse(String(value)) as T
const failure = (message: string): Result<never> => err({ _tag: 'Configuration', message })

function privateDirectory(path: string): string {
  const directory = dirname(resolve(path))
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const canonical = realpathSync(directory)
  if (process.getuid && lstatSync(canonical).uid !== process.getuid())
    throw new Error('Choose a state or backup directory owned by the controller.')
  chmodSync(canonical, 0o700)
  return `${canonical}/${basename(path)}`
}

function privateFile(path: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path)
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()))
      throw new Error('State and backup files must be owned regular files, without symbolic links.')
  }
  closeSync(openSync(path, 'a', 0o600))
  chmodSync(path, 0o600)
}

function acquireLock(path: string): () => void {
  const lockPath = `${path}.lock`
  privateFile(lockPath)
  const lock = new DatabaseSync(lockPath)
  try {
    chmodSync(lockPath, 0o600)
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS controller (id INTEGER PRIMARY KEY);')
  }
  catch (cause) {
    lock.close()
    throw new Error('Another controller holds the state lock, or its lock database is unavailable.', { cause })
  }
  return () => {
    try {
      lock.exec('ROLLBACK')
    }
    finally {
      lock.close()
    }
  }
}

export function openStore(options: StoreOptions) {
  const now = options.now ?? (() => new Date())
  const memory = options.path === ':memory:'
  let path = options.path
  if (!memory) {
    path = privateDirectory(path)
    privateFile(path)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${path}${suffix}`))
        privateFile(`${path}${suffix}`)
    }
  }
  const release = memory ? () => {} : acquireLock(path)
  const db = (() => {
    try {
      return new DatabaseSync(path)
    }
    catch (cause) {
      release()
      throw cause
    }
  })()
  try {
    const openedVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version)
    if (openedVersion > schemaVersion) {
      throw new Error(`State schema ${openedVersion} requires a newer Octorun version. Restore a compatible backup before rollback.`)
    }
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, data TEXT NOT NULL, received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL,
      run_after TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, trigger_key TEXT NOT NULL UNIQUE, group_key TEXT NOT NULL,
      repository TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_group ON runs(group_key, created_at);
    CREATE INDEX IF NOT EXISTS runs_status ON runs(status, created_at);
    CREATE TABLE IF NOT EXISTS publications (
      id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL,
      task_id TEXT NOT NULL, status TEXT NOT NULL, effect_digest TEXT NOT NULL, data TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id)
    );
    CREATE INDEX IF NOT EXISTS publications_run ON publications(run_id, status);
    CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS controls (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, run_id TEXT,
      kind TEXT NOT NULL, data TEXT NOT NULL
    );
    PRAGMA user_version=${schemaVersion};
  `)
    if (!memory)
      chmodSync(path, 0o600)
  }
  catch (cause) {
    try {
      db.close()
    }
    finally {
      release()
    }
    throw cause
  }
  let transactionDepth = 0
  let closed = false

  const transaction = <T>(operation: () => T): T => {
    if (transactionDepth > 0)
      return operation()
    db.exec('BEGIN IMMEDIATE')
    transactionDepth++
    try {
      const value = operation()
      db.exec('COMMIT')
      return value
    }
    catch (cause) {
      db.exec('ROLLBACK')
      throw cause
    }
    finally {
      transactionDepth--
    }
  }
  const log = (kind: string, data: JsonValue, runId: string | null = null): void => {
    db.prepare('INSERT INTO logs(at, run_id, kind, data) VALUES (?, ?, ?, ?)').run(now().toISOString(), runId, kind, JSON.stringify(data))
  }
  const getRun = (id: string): RunRecord | null => {
    const row = db.prepare('SELECT data FROM runs WHERE id = ?').get(id)
    return row ? json<RunRecord>(row.data) : null
  }
  const writeRun = (run: RunRecord): void => {
    db.prepare('UPDATE runs SET status = ?, updated_at = ?, data = ? WHERE id = ?').run(run.state._tag, run.updatedAt, JSON.stringify(run), run.id)
  }
  const getPublication = (id: string): PublicationRecord | null => {
    const row = db.prepare('SELECT data FROM publications WHERE id = ?').get(id)
    return row ? json<PublicationRecord>(row.data) : null
  }
  const writePublication = (publication: PublicationRecord): void => {
    db.prepare('UPDATE publications SET status = ?, data = ? WHERE id = ?').run(publication.state._tag, JSON.stringify(publication), publication.id)
  }
  const control = (key: string): JsonValue | null => {
    const row = db.prepare('SELECT data FROM controls WHERE key = ?').get(key)
    return row ? json<JsonValue>(row.data) : null
  }
  const setControl = (key: string, value: JsonValue): void => {
    db.prepare('INSERT INTO controls(key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(value))
  }

  return {
    path,
    schemaVersion,
    transaction,
    log,
    acceptDelivery(input: { id: string, event: string, body: string, receivedAt: string }): Result<{ id: string, duplicate: boolean }> {
      return transaction(() => {
        const fingerprint = digest({ event: input.event, body: input.body })
        const previous = db.prepare('SELECT fingerprint FROM deliveries WHERE id = ?').get(input.id)
        if (previous)
          return previous.fingerprint === fingerprint ? ok({ id: input.id, duplicate: true }) : failure('The delivery ID already identifies different input.')
        const delivery: StoredDelivery = { ...input, state: 'Queued', attempts: 0, runAfter: input.receivedAt, error: null }
        db.prepare('INSERT INTO deliveries(id, fingerprint, status, run_after, data) VALUES (?, ?, ?, ?, ?)').run(input.id, fingerprint, 'Queued', input.receivedAt, JSON.stringify(delivery))
        log('delivery.accepted', { deliveryId: input.id, event: input.event })
        return ok({ id: input.id, duplicate: false })
      })
    },
    pendingDeliveries(): StoredDelivery[] {
      return db.prepare('SELECT data FROM deliveries WHERE status=\'Queued\' AND run_after <= ? ORDER BY rowid LIMIT 100').all(now().toISOString()).map(row => json<StoredDelivery>(row.data))
    },
    updateDelivery(id: string, update: (delivery: StoredDelivery) => StoredDelivery): StoredDelivery | null {
      return transaction(() => {
        const row = db.prepare('SELECT data FROM deliveries WHERE id = ?').get(id)
        if (!row)
          return null
        const next = update(json<StoredDelivery>(row.data))
        if (next.id !== id)
          throw new Error('A delivery cannot change identity.')
        db.prepare('UPDATE deliveries SET status=?, run_after=?, data=? WHERE id=?').run(next.state, next.runAfter, JSON.stringify(next), id)
        return next
      })
    },
    event(id: string): EventEnvelope | null {
      const row = db.prepare('SELECT data FROM events WHERE id = ?').get(id)
      return row ? json<EventEnvelope>(row.data) : null
    },
    recordEvent(event: EventEnvelope): Result<{ eventId: string, duplicate: boolean }> {
      return transaction(() => {
        const { receivedAt: _receivedAt, ...identity } = event
        const fingerprint = digest(identity)
        const existing = db.prepare('SELECT fingerprint FROM events WHERE id = ?').get(event.id)
        if (existing)
          return existing.fingerprint === fingerprint ? ok({ eventId: event.id, duplicate: true }) : failure('The event request ID already identifies different inputs.')
        db.prepare('INSERT INTO events(id, fingerprint, data, received_at) VALUES (?, ?, ?, ?)').run(event.id, fingerprint, JSON.stringify(event), event.receivedAt)
        log('event.accepted', { eventId: event.id, repository: event.repository.fullName, name: event.name })
        return ok({ eventId: event.id, duplicate: false })
      })
    },
    run: getRun,
    runByTrigger(key: string): RunRecord | null {
      const row = db.prepare('SELECT data FROM runs WHERE trigger_key = ?').get(key)
      return row ? json<RunRecord>(row.data) : null
    },
    createRun(run: RunRecord, keys: { trigger: string, group: string }): { run: RunRecord, duplicate: boolean } {
      return transaction(() => {
        const existing = db.prepare('SELECT data FROM runs WHERE trigger_key = ?').get(keys.trigger)
        if (existing)
          return { run: json<RunRecord>(existing.data), duplicate: true }
        db.prepare('INSERT INTO runs(id, trigger_key, group_key, repository, status, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(run.id, keys.trigger, keys.group, run.event.repository.fullName, run.state._tag, run.createdAt, run.updatedAt, JSON.stringify(run))
        log('run.created', { workflow: run.definition.id, eventId: run.event.id }, run.id)
        return { run, duplicate: false }
      })
    },
    updateRun(id: string, update: (run: RunRecord) => RunRecord): RunRecord | null {
      return transaction(() => {
        const run = getRun(id)
        if (!run)
          return null
        const next = update(run)
        if (next.id !== id)
          throw new Error('A stored run cannot change identity.')
        writeRun(next)
        return next
      })
    },
    runs(filter: { repository?: string, states?: string[], limit?: number, group?: string } = {}): RunRecord[] {
      const clauses: string[] = []
      const values: (string | number)[] = []
      if (filter.repository) {
        clauses.push('repository = ?')
        values.push(filter.repository)
      }
      if (filter.states?.length) {
        clauses.push(`status IN (${filter.states.map(() => '?').join(',')})`)
        values.push(...filter.states)
      }
      if (filter.group) {
        clauses.push('group_key = ?')
        values.push(filter.group)
      }
      values.push(Math.min(10000, Math.max(1, filter.limit ?? 1000)))
      return db.prepare(`SELECT data FROM runs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at, rowid LIMIT ?`).all(...values).map(row => json<RunRecord>(row.data))
    },
    publication: getPublication,
    enqueueSystem(publication: PublicationRecord): Result<string> {
      return transaction(() => {
        if (publication.taskId !== '__lifecycle' || !getRun(publication.runId))
          return failure('Lifecycle publication requires an existing workflow run.')
        const key = `${publication.runId}:${publication.taskId}:${publication.key}`
        const existing = db.prepare('SELECT data, effect_digest FROM publications WHERE dedupe_key = ?').get(key)
        if (existing) {
          const previous = json<PublicationRecord>(existing.data)
          return existing.effect_digest === digest(publication.effect) ? ok(previous.id) : failure('The publication key already identifies different output.')
        }
        db.prepare('INSERT INTO publications(id, dedupe_key, run_id, task_id, status, effect_digest, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(publication.id, key, publication.runId, publication.taskId, publication.state._tag, digest(publication.effect), JSON.stringify(publication))
        return ok(publication.id)
      })
    },
    enqueue(publication: PublicationRecord, fence: number): Result<string> {
      return transaction(() => {
        const run = getRun(publication.runId)
        const task = run?.tasks.find(item => item.id === publication.taskId)
        if (!run || terminalStates.includes(run.state._tag) || task?.state._tag !== 'Running' || task.fence !== fence)
          return err({ _tag: 'Authorization', message: 'The task no longer owns publication authority.' })
        const key = `${publication.runId}:${publication.taskId}:${publication.key}`
        const existing = db.prepare('SELECT data, effect_digest FROM publications WHERE dedupe_key = ?').get(key)
        if (existing) {
          const previous = json<PublicationRecord>(existing.data)
          return existing.effect_digest === digest(publication.effect) ? ok(previous.id) : failure('The publication key already identifies different output.')
        }
        db.prepare('INSERT INTO publications(id, dedupe_key, run_id, task_id, status, effect_digest, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(publication.id, key, publication.runId, publication.taskId, publication.state._tag, digest(publication.effect), JSON.stringify(publication))
        log('publication.prepared', { publicationId: publication.id, effect: publication.effect._tag }, run.id)
        return ok(publication.id)
      })
    },
    updatePublication(id: string, update: (publication: PublicationRecord) => PublicationRecord): PublicationRecord | null {
      return transaction(() => {
        const publication = getPublication(id)
        if (!publication)
          return null
        const next = update(publication)
        if (next.id !== id)
          throw new Error('A stored publication cannot change identity.')
        writePublication(next)
        return next
      })
    },
    publications(filter: { runId?: string, states?: string[] } = {}): PublicationRecord[] {
      const clauses: string[] = []
      const values: string[] = []
      if (filter.runId) {
        clauses.push('run_id = ?')
        values.push(filter.runId)
      }
      if (filter.states?.length) {
        clauses.push(`status IN (${filter.states.map(() => '?').join(',')})`)
        values.push(...filter.states)
      }
      return db.prepare(`SELECT data FROM publications ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY rowid`).all(...values).map(row => json<PublicationRecord>(row.data))
    },
    cursor(key: string): JsonValue | null {
      const row = db.prepare('SELECT data FROM cursors WHERE key = ?').get(key)
      return row ? json<JsonValue>(row.data) : null
    },
    setCursor(key: string, value: JsonValue): void {
      db.prepare('INSERT INTO cursors(key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(value))
    },
    paused(repository: string, target: string): boolean {
      return control(`pause:${repository.toLowerCase()}:*`) === true || control(`pause:${repository.toLowerCase()}:${target}`) === true
    },
    setPause(repository: string, target: string | null, value: boolean): void {
      setControl(`pause:${repository.toLowerCase()}:${target ?? '*'}`, value)
      log('control.pause', { repository, target, paused: value })
    },
    operatorPaused: (): boolean => control('operator.pause') === true,
    setOperatorPause(value: boolean): void {
      setControl('operator.pause', value)
      log('control.admission', { paused: value })
    },
    logs(filter: { runId?: string, limit?: number } = {}): StoreLog[] {
      const rows = filter.runId
        ? db.prepare('SELECT * FROM logs WHERE run_id = ? ORDER BY id DESC LIMIT ?').all(filter.runId, Math.min(1000, Math.max(1, filter.limit ?? 100)))
        : db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(Math.min(1000, Math.max(1, filter.limit ?? 100)))
      return rows.map(row => ({ id: Number(row.id), at: String(row.at), runId: row.run_id === null ? null : String(row.run_id), kind: String(row.kind), data: json<JsonValue>(row.data) }))
    },
    async backup(destination: string): Promise<void> {
      destination = privateDirectory(destination)
      if (resolve(destination) === path)
        throw new Error('Choose a backup path outside the live database.')
      privateFile(destination)
      await backup(db, destination)
      await chmod(destination, 0o600)
    },
    prune(options: { before: string }): { logs: number, eventPayloads: number, runPayloads: number } {
      if (!Number.isFinite(Date.parse(options.before)))
        throw new Error('Retention requires a valid cutoff timestamp.')
      return transaction(() => {
        const logs = Number(db.prepare('DELETE FROM logs WHERE at < ? AND (run_id IS NULL OR run_id IN (SELECT id FROM runs WHERE status IN (\'Succeeded\',\'Failed\',\'Cancelled\',\'Superseded\',\'Skipped\')))').run(options.before).changes)
        const rows = db.prepare('SELECT id, data FROM events WHERE received_at < ?').all(options.before)
        let eventPayloads = 0
        for (const row of rows) {
          const event = json<EventEnvelope>(row.data)
          const active = db.prepare('SELECT 1 FROM runs WHERE json_extract(data, \'$.event.id\') = ? AND status NOT IN (\'Succeeded\',\'Failed\',\'Cancelled\',\'Superseded\',\'Skipped\') LIMIT 1').get(event.id)
          if (active)
            continue
          db.prepare('UPDATE events SET data = ? WHERE id = ?').run(JSON.stringify({ ...event, data: null }), event.id)
          eventPayloads++
        }
        const deliveries = db.prepare('SELECT id, data FROM deliveries WHERE status != \'Queued\' AND run_after < ?').all(options.before)
        for (const row of deliveries) {
          const delivery = json<StoredDelivery>(row.data)
          db.prepare('UPDATE deliveries SET data = ? WHERE id = ?').run(JSON.stringify({ ...delivery, body: '' }), delivery.id)
        }
        const completed = db.prepare('SELECT data FROM runs WHERE status IN (\'Succeeded\',\'Failed\',\'Cancelled\',\'Superseded\',\'Skipped\') AND updated_at < ?').all(options.before)
        let runPayloads = 0
        for (const row of completed) {
          const run = json<RunRecord>(row.data)
          if (run.event.data !== null || run.tasks.some(task => task.output !== null)) {
            writeRun({ ...run, event: { ...run.event, data: null }, tasks: run.tasks.map(task => ({ ...task, output: null })) })
            runPayloads++
          }
          const publications = db.prepare('SELECT data FROM publications WHERE run_id = ? AND status IN (\'Written\',\'Failed\',\'Cancelled\')').all(run.id)
          for (const row of publications) {
            const publication = json<PublicationRecord>(row.data)
            const effect = publication.effect._tag === 'Check'
              ? { ...publication.effect, summary: '' }
              : publication.effect._tag === 'Review'
                ? { ...publication.effect, body: '', comments: [] }
                : { ...publication.effect, body: '' }
            writePublication({ ...publication, effect })
          }
        }
        return { logs, eventPayloads, runPayloads }
      })
    },
    close(): void {
      if (closed)
        return
      db.close()
      release()
      closed = true
    },
  }
}

export type WorkflowStore = ReturnType<typeof openStore>

export async function restoreStoreBackup(options: { source: string, destination: string }): Promise<void> {
  const destination = privateDirectory(options.destination)
  if (resolve(options.source) === destination)
    throw new Error('Choose separate source and destination paths for restore.')
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  const release = acquireLock(destination)
  const staged = `${destination}.restore-${randomUUID()}`
  try {
    const source = new DatabaseSync(options.source, { readOnly: true })
    try {
      const version = Number(source.prepare('PRAGMA user_version').get()?.user_version)
      const check = source.prepare('PRAGMA quick_check').get()
      if (version !== schemaVersion || check?.quick_check !== 'ok')
        throw new Error('The backup is corrupt or uses an incompatible state schema.')
    }
    finally {
      source.close()
    }
    await copyFile(options.source, staged)
    await chmod(staged, 0o600)
    await rm(`${destination}-wal`, { force: true })
    await rm(`${destination}-shm`, { force: true })
    await rename(staged, destination)
  }
  finally {
    try {
      await rm(staged, { force: true })
    }
    finally {
      release()
    }
  }
}
