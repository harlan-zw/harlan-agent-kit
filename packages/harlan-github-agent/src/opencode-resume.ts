import type { Result } from './result.ts'
import { constants } from 'node:fs'
import { open, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { opencodeTaskDirectory } from './opencode-storage.ts'
import { err, ok } from './result.ts'

interface OpencodeResume {
  binary: string
  args: string[]
  environment: NodeJS.ProcessEnv
}

async function savedSession(path: string, sessionId: string): Promise<'Absent' | 'Found' | 'Missing'> {
  const parent = await realpath(dirname(path)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return undefined
    throw error
  })
  if (parent === undefined)
    return 'Absent'
  if (parent !== resolve(dirname(path)))
    throw new Error('The OpenCode database directory must not use an alias.')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return undefined
    throw error
  })
  if (file === undefined)
    return 'Absent'
  try {
    if (!(await file.stat()).isFile())
      throw new Error('The OpenCode database must use an ordinary file.')
    const database = new DatabaseSync(`/proc/self/fd/${file.fd}`, { readOnly: true })
    try {
      return database.prepare('SELECT id FROM session WHERE id = ?').get(sessionId) === undefined ? 'Missing' : 'Found'
    }
    finally {
      database.close()
    }
  }
  finally {
    await file.close()
  }
}

/** Resume only the selected Task's native conversation. Older shared data stays unchanged. */
export async function resolveOpencodeResume(input: { profilePath: string, taskKey: string, sessionId: string, environment: NodeJS.ProcessEnv }): Promise<Result<OpencodeResume, string>> {
  if (!/^[a-f0-9]{64}$/.test(input.taskKey) || !/^ses_[a-z0-9]{8,}$/i.test(input.sessionId))
    return err('The OpenCode session or Task key is invalid.')
  const profile: unknown = JSON.parse(await readFile(input.profilePath, 'utf8'))
  if (typeof profile !== 'object' || profile === null || !('home' in profile) || !('opencode' in profile)
    || typeof profile.home !== 'string' || !isAbsolute(profile.home) || typeof profile.opencode !== 'string' || !isAbsolute(profile.opencode)) {
    throw new Error('The Agent worker configuration must contain absolute home and OpenCode paths.')
  }
  let database = join(opencodeTaskDirectory(input.environment.HOME ?? '/home/harlan', input.taskKey), 'opencode.db')
  const selected = await savedSession(database, input.sessionId)
  if (selected === 'Missing')
    return err('The saved OpenCode session belongs to another Task.')
  if (selected === 'Absent') {
    database = join(profile.home, '.local/share/opencode/opencode.db')
    if (await savedSession(database, input.sessionId) !== 'Found')
      return err('The saved OpenCode session is unavailable.')
  }
  return ok({
    binary: profile.opencode,
    args: ['--session', input.sessionId],
    environment: { ...input.environment, HOME: profile.home, XDG_CONFIG_HOME: join(profile.home, '.config'), XDG_DATA_HOME: join(profile.home, '.local/share'), XDG_STATE_HOME: join(profile.home, '.local/state'), OPENCODE_DB: database },
  })
}
