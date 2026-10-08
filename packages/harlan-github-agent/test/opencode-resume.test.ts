import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { resolveOpencodeResume } from '../src/opencode-resume.ts'
import { opencodeTaskKey, prepareOpencodeTaskDirectory } from '../src/opencode-storage.ts'

const execute = promisify(execFile)

it('resumes the exact persisted Task session and rejects an older Task session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'opencode-resume-'))
  const worker = join(home, 'worker')
  const profile = join(home, 'worker.json')
  const key = opencodeTaskKey('owner/site:daily-checkin:2026-10-08T00:00:00.000Z')
  try {
    await mkdir(worker)
    await writeFile(profile, JSON.stringify({ home: worker, opencode: process.execPath }))
    const directory = await prepareOpencodeTaskDirectory(home, key)
    const database = new DatabaseSync(join(directory, 'opencode.db'))
    database.exec('PRAGMA journal_mode=WAL; CREATE TABLE session(id TEXT PRIMARY KEY); INSERT INTO session VALUES(\'ses_current123\');')
    // Keep WAL open. The resolver must read the actual native database, including its sidecar.
    const input = { profilePath: profile, taskKey: key, sessionId: 'ses_current123', environment: { HOME: home } }
    const result = await resolveOpencodeResume(input)
    expect(result._tag).toBe('Ok')
    if (result._tag === 'Err')
      throw new Error(result.error)
    const proof = await execute(result.value.binary, ['--input-type=module', '-e', 'import {DatabaseSync} from \'node:sqlite\'; const db=new DatabaseSync(process.env.OPENCODE_DB,{readOnly:true}); console.log(db.prepare(\'SELECT id FROM session\').get().id); db.close()'], { env: result.value.environment })
    expect(proof.stdout.trim()).toBe('ses_current123')
    expect(result.value.args).toEqual(['--session', 'ses_current123'])
    const provider = join(home, 'native-provider')
    await writeFile(provider, `#!${process.execPath}\nimport { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.env.OPENCODE_DB, {readOnly:true}); console.log(JSON.stringify({session:db.prepare('SELECT id FROM session WHERE id=?').get(process.argv[3]).id, args:process.argv.slice(2), home:process.env.HOME})); db.close()`, { mode: 0o700 })
    await writeFile(profile, JSON.stringify({ home: worker, opencode: provider }))
    const launched = await execute(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'resume-session', '--worker-profile', profile, '--task-key', key, '--session', 'ses_current123'], { env: { ...process.env, HOME: home }, timeout: 5000 })
    expect(JSON.parse(launched.stdout)).toEqual({ session: 'ses_current123', args: ['--session', 'ses_current123'], home: worker })
    database.close()
    const legacyPath = join(worker, '.local/share/opencode/opencode.db')
    await mkdir(dirname(legacyPath), { recursive: true })
    const legacy = new DatabaseSync(legacyPath)
    legacy.exec('CREATE TABLE session(id TEXT PRIMARY KEY); INSERT INTO session VALUES(\'ses_previous123\');')
    legacy.close()
    expect(await resolveOpencodeResume({ ...input, sessionId: 'ses_previous123' })).toEqual({ _tag: 'Err', error: 'The saved OpenCode session belongs to another Task.' })
    const fallback = await resolveOpencodeResume({ ...input, taskKey: opencodeTaskKey('old-task'), sessionId: 'ses_previous123' })
    expect(fallback._tag).toBe('Ok')
    expect(await resolveOpencodeResume({ ...input, taskKey: opencodeTaskKey('old-task'), sessionId: 'ses_missing123' })).toEqual({ _tag: 'Err', error: 'The saved OpenCode session is unavailable.' })
    await rm(join(directory, 'opencode.db'))
    await symlink(legacyPath, join(directory, 'opencode.db'))
    await expect(resolveOpencodeResume(input)).rejects.toMatchObject({ code: 'ELOOP' })
  }
  finally {
    await rm(home, { recursive: true, force: true })
  }
})

it('refuses aliases in the controller-owned storage parents', async () => {
  const home = await mkdtemp(join(tmpdir(), 'opencode-storage-'))
  try {
    await mkdir(join(home, 'other'))
    await symlink(join(home, 'other'), join(home, '.local'))
    await expect(prepareOpencodeTaskDirectory(home, opencodeTaskKey('task'))).rejects.toThrow()
    await expect(resolveOpencodeResume({ profilePath: '/missing', taskKey: '../bad', sessionId: 'ses_example123', environment: { HOME: home } })).resolves.toMatchObject({ _tag: 'Err' })
  }
  finally {
    await rm(home, { recursive: true, force: true })
  }
})
