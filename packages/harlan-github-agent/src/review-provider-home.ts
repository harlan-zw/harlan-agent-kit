import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export interface ReviewHomeRelease { _tag: 'Released', warnings: string[] }

/** Serializes controller Review writers. External SDK writers do not participate in this lock. */
async function withLoginLock<T>(path: string, effect: () => Promise<T>): Promise<T> {
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  if (!(await file.stat()).isFile()) {
    await file.close()
    throw new Error('The Review login lock requires a regular file.')
  }
  const child = spawn('/usr/bin/flock', ['--exclusive', '--timeout', '10', '/proc/self/fd/3', '/bin/cat'], { stdio: ['pipe', 'pipe', 'ignore', file.fd], env: { PATH: '/usr/bin:/bin' } })
  const stdin = child.stdin!
  const stdout = child.stdout!
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error('The controller could not lock the Review login.')))
  })
  // A fixed echo proves flock acquired the lock. No login contents enter this pipe.
  const ready = new Promise<void>((resolve, reject) => {
    stdout.once('data', () => resolve())
    child.once('error', reject)
    child.once('close', () => reject(new Error('The controller could not lock the Review login.')))
  })
  stdin.on('error', () => { /* The exit status reports a failed lock acquisition. */ })
  stdin.write('locked\n')
  try {
    await Promise.race([ready, closed])
    return await effect()
  }
  finally {
    stdin.end()
    await closed.finally(() => file.close())
  }
}

async function saveLogin(input: { worker: string, home: string, name: string, original: string | null, lock: string }): Promise<ReviewHomeRelease> {
  const refreshed = await namedFile(input.home, input.name, true)
  if (refreshed === null || refreshed === input.original)
    return { _tag: 'Released', warnings: [] }
  return withLoginLock(input.lock, async () => {
    const directoryPath = join(input.worker, dirname(input.name))
    // Reject every symlink component before opening the destination directory.
    let current = input.worker
    for (const part of dirname(input.name).split('/')) {
      current = join(current, part)
      const metadata = await lstat(current)
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error('The Review login directory must stay inside the worker home.')
    }
    const directory = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const pinned = `/proc/self/fd/${directory.fd}`
    let temporary: string | undefined
    try {
      const canonical = await realpath(pinned)
      if (canonical !== directoryPath || !canonical.startsWith(`${input.worker}/`))
        throw new Error('The Review login directory changed during refresh.')
      const name = input.name.slice(input.name.lastIndexOf('/') + 1)
      const destination = await namedFile(pinned, name, true)
      if (destination !== input.original)
        return { _tag: 'Released', warnings: ['The Review login changed concurrently. The controller preserved the current login.'] }
      temporary = join(pinned, `.review-login-${process.pid}-${randomUUID()}`)
      await writeFile(temporary, refreshed, { flag: 'wx', mode: 0o600 })
      // The directory descriptor pins this rename. SDK writers outside the lock can still race this comparison.
      await rename(temporary, join(pinned, name))
      temporary = undefined
      return { _tag: 'Released', warnings: [] }
    }
    finally {
      if (temporary !== undefined)
        await rm(temporary, { force: true })
      await directory.close()
    }
  })
}

async function namedFile(root: string, name: string, optional = false): Promise<string | null> {
  let current = root
  for (const part of name.split('/')) {
    current = join(current, part)
    const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (optional && error.code === 'ENOENT')
        return null
      throw error
    })
    if (metadata === null)
      return null
    if (metadata.isSymbolicLink())
      throw new Error('The Review provider login must not use symlinks.')
  }
  const file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (optional && error.code === 'ENOENT')
      return null
    throw error
  })
  if (file === null)
    return null
  try {
    const path = await realpath(`/proc/self/fd/${file.fd}`)
    const canonicalRoot = await realpath(root)
    const metadata = await file.stat()
    if (path !== join(canonicalRoot, name) || !metadata.isFile() || metadata.size > 100_000)
      throw new Error('The Review provider login must use a bounded file inside the worker home.')
    const buffer = Buffer.alloc(100_001)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 100_000)
      throw new Error('The Review provider login exceeds its byte limit.')
    return buffer.subarray(0, bytesRead).toString('utf8')
  }
  finally {
    await file.close()
  }
}

function namedOpencodeLogin(source: string | null): Record<string, unknown> | undefined {
  if (source === null)
    return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(source) as unknown
  }
  catch {
    throw new Error('The named OpenCode login configuration requires JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || !('provider' in parsed))
    return undefined
  const provider = parsed.provider
  if (typeof provider !== 'object' || provider === null || !('zai-coding-plan' in provider))
    return undefined
  const named = provider['zai-coding-plan']
  if (typeof named !== 'object' || named === null || !('options' in named))
    return undefined
  const options = named.options
  if (typeof options !== 'object' || options === null || !('apiKey' in options) || typeof options.apiKey !== 'string' || options.apiKey.length === 0)
    return undefined
  return { 'zai-coding-plan': { options: { apiKey: options.apiKey } } }
}

/** Copies named provider login files. All executable configuration comes from the controller. */
export async function createReviewProviderHome(input: { profilePath: string, provider: 'codex' | 'opencode', configuration: string }): Promise<{ home: string, release: () => Promise<ReviewHomeRelease> }> {
  const profile = JSON.parse(await readFile(input.profilePath, 'utf8')) as { home?: unknown }
  if (typeof profile.home !== 'string' || !isAbsolute(profile.home))
    throw new Error('The Review worker home must use an absolute path.')
  const worker = await realpath(profile.home)
  const lockDirectory = await realpath(dirname(input.profilePath))
  if (lockDirectory === worker || lockDirectory.startsWith(`${worker}/`))
    throw new Error('The Review login lock must stay in the controller configuration directory.')
  const home = await mkdtemp(join(tmpdir(), 'review-provider-home-'))
  const name = input.provider === 'codex' ? '.codex/auth.json' : '.local/share/opencode/auth.json'
  let original: string | null = null
  const release = async () => {
    try {
      return await saveLogin({ worker, home, name, original, lock: join(lockDirectory, `review-${input.provider}-login.lock`) })
    }
    finally {
      await rm(home, { recursive: true, force: true })
    }
  }
  try {
    if (input.provider === 'codex') {
      await mkdir(join(home, '.codex'), { mode: 0o700 })
      original = await namedFile(worker, name)
      await writeFile(join(home, name), original!, { mode: 0o600 })
      await writeFile(join(home, '.codex/config.toml'), input.configuration, { mode: 0o600 })
      await mkdir(join(home, '.config/opencode'), { recursive: true, mode: 0o700 })
      await writeFile(join(home, '.config/opencode/opencode.json'), '{"permission":{"*":"deny"}}', { mode: 0o600 })
    }
    else {
      await Promise.all([mkdir(join(home, '.local/share/opencode'), { recursive: true, mode: 0o700 }), mkdir(join(home, '.config/opencode'), { recursive: true, mode: 0o700 })])
      const auth = await namedFile(worker, name, true)
      original = auth
      const configured = await namedFile(profile.home, '.config/opencode/opencode.json', true)
      if (auth === null && configured === null)
        throw new Error('The Review worker needs its named OpenCode login.')
      if (auth !== null)
        await writeFile(join(home, '.local/share/opencode/auth.json'), auth, { mode: 0o600 })
      const provider = namedOpencodeLogin(configured)
      if (auth === null && provider === undefined)
        throw new Error('The Review worker needs a supported named OpenCode login.')
      const configuration = JSON.parse(input.configuration) as Record<string, unknown>
      await writeFile(join(home, '.config/opencode/opencode.json'), JSON.stringify({ ...configuration, ...(provider === undefined ? {} : { provider }) }), { mode: 0o600 })
    }
    return { home, release }
  }
  catch (error) {
    await rm(home, { recursive: true, force: true })
    throw error
  }
}
