import type { Result } from './result.ts'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readlink, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { err, ok } from './result.ts'

export type TerminalDiffSource =
  | { _tag: 'Working' }
  | { _tag: 'Staged' }
  | { _tag: 'Comparison'; base: string; head: string }
export type TerminalDiffError = 'InvalidRequest' | 'Unavailable' | 'TooLarge' | 'Binary' | 'Symlink' | 'Changed'
export interface TerminalDiffFile {
  path: string
  status: string
  stamp: string | null
  blob: string | null
}
export interface TerminalDiffSnapshot {
  id: string
  root: string
  base: string
  source: TerminalDiffSource
  files: TerminalDiffFile[]
}
export interface TerminalFileDiff {
  path: string
  generation: string
  oldText: string
  newText: string
}
const execute = promisify(execFile)
const MAX_BYTES = 2 * 1024 * 1024
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const environment = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' }
const safeConfig = ['-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat']

function code(cause: unknown): unknown {
  return typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
}
function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !isAbsolute(path) &&
    !path.includes('\0') &&
    !path.split('/').includes('..')
  )
}
async function git(root: string, args: string[], config = safeConfig): Promise<Buffer> {
  const result = await execute('git', [...config, ...args], {
    cwd: root,
    env: environment,
    encoding: 'buffer',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 10000,
  })
  return result.stdout
}
async function readConfig(root: string): Promise<string[]> {
  const config = (await git(root, ['config', '--null', '--list'])).toString('utf8')
  const drivers = new Set(
    config
      .split('\0')
      .map((entry) => /^filter\.(.+)\.(?:clean|process|required)\n/.exec(entry)?.[1])
      .filter((name): name is string => name !== undefined),
  )
  return [
    ...safeConfig,
    ...Array.from(drivers).flatMap((name) => [
      '-c',
      `filter.${name}.clean=`,
      '-c',
      `filter.${name}.process=`,
      '-c',
      `filter.${name}.required=false`,
    ]),
  ]
}
async function stamp(root: string, path: string): Promise<string | null> {
  return lstat(join(root, path), { bigint: true })
    .then((value) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`)
    .catch((cause: unknown) => {
      if (code(cause) === 'ENOENT') return null
      throw cause
    })
}
async function boundary<T>(
  operation: () => Promise<Result<T, TerminalDiffError>>,
): Promise<Result<T, TerminalDiffError>> {
  return operation().catch((cause: unknown) => {
    if (code(cause) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return err('TooLarge')
    if (typeof code(cause) === 'number' || ['ENOENT', 'EACCES', 'ENOTDIR'].includes(String(code(cause))))
      return err('Unavailable')
    throw cause
  })
}

export async function listTerminalDiff(
  worktree: string,
  source: TerminalDiffSource,
): Promise<Result<TerminalDiffSnapshot, TerminalDiffError>> {
  if (
    source._tag === 'Comparison' &&
    (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(source.base) || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(source.head))
  )
    return err('InvalidRequest')
  return boundary(async () => {
    const root = await realpath(worktree)
    const actualRoot = await realpath((await git(root, ['rev-parse', '--show-toplevel'])).toString('utf8').trim())
    if (root !== actualRoot) return err('InvalidRequest')
    const config = await readConfig(root)
    const base =
      source._tag === 'Comparison'
        ? source.base
        : (await git(root, ['rev-parse', '--verify', 'HEAD'])).toString('utf8').trim()
    const files: TerminalDiffFile[] = []
    if (source._tag === 'Working') {
      const entries = (
        await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], config)
      )
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
      for (const entry of entries) {
        const path = entry.slice(3)
        if (!safePath(path)) return err('InvalidRequest')
        files.push({ path, status: entry.slice(0, 2).trim(), stamp: await stamp(root, path), blob: null })
        if (files.length > 500) return err('TooLarge')
      }
    } else {
      const args = [
        'diff',
        '--name-status',
        '-z',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        ...(source._tag === 'Staged' ? ['--cached', base] : [source.base, source.head]),
        '--',
      ]
      const entries = (await git(root, args, config)).toString('utf8').split('\0').filter(Boolean)
      for (let index = 0; index < entries.length; index += 2) {
        const path = entries[index + 1]
        if (path === undefined || !safePath(path)) return err('InvalidRequest')
        const blob =
          source._tag === 'Staged' && entries[index] !== 'D'
            ? (await git(root, ['rev-parse', '--verify', `:${path}`])).toString('utf8').trim()
            : null
        files.push({ path, status: entries[index] ?? '', stamp: null, blob })
        if (files.length > 500) return err('TooLarge')
      }
    }
    return ok({ id: hash(JSON.stringify({ root, base, source, files })), root, base, source, files })
  })
}

async function objectText(root: string, revision: string, path: string): Promise<Buffer> {
  const exists = await git(root, ['cat-file', '-e', `${revision}:${path}`])
    .then(() => true)
    .catch((cause: unknown) => {
      if (code(cause) === 128 || code(cause) === 1) return false
      throw cause
    })
  return exists ? git(root, ['show', `${revision}:${path}`]) : Buffer.alloc(0)
}

async function workingText(root: string, file: TerminalDiffFile): Promise<Result<Buffer, TerminalDiffError>> {
  const before = await stamp(root, file.path)
  if (before !== file.stamp) return err('Changed')
  if (before === null) return ok(Buffer.alloc(0))
  const handle = await open(
    join(root, file.path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((cause: unknown) => {
    if (code(cause) === 'ELOOP') return null
    throw cause
  })
  if (handle === null) return err('Symlink')
  return (async (): Promise<Result<Buffer, TerminalDiffError>> => {
    // Check the opened inode before reading. Parent symlink races cannot expose outside contents.
    const opened = await readlink(`/proc/self/fd/${handle.fd}`)
    const location = relative(root, opened)
    if (location.startsWith('../') || isAbsolute(location)) return err('Symlink')
    const metadata = await handle.stat()
    if (!metadata.isFile()) return err('Symlink')
    if (metadata.size > MAX_BYTES) return err('TooLarge')
    const bytes = Buffer.alloc(MAX_BYTES + 1)
    const count = await handle.read(bytes, 0, bytes.length, 0)
    if (count.bytesRead > MAX_BYTES) return err('TooLarge')
    if ((await stamp(root, file.path)) !== before) return err('Changed')
    return ok(bytes.subarray(0, count.bytesRead))
  })().finally(() => handle.close())
}

export async function readTerminalDiff(
  worktree: string,
  snapshot: TerminalDiffSnapshot,
  path: string,
): Promise<Result<TerminalFileDiff, TerminalDiffError>> {
  const file = snapshot.files.find((value) => value.path === path)
  if (!file || !safePath(path)) return err('InvalidRequest')
  return boundary(async () => {
    const root = await realpath(worktree)
    if (root !== snapshot.root) return err('InvalidRequest')
    const oldBytes = await objectText(root, snapshot.base, path)
    const current =
      snapshot.source._tag === 'Working'
        ? await workingText(root, file)
        : snapshot.source._tag === 'Staged'
          ? ok(file.blob === null ? Buffer.alloc(0) : await git(root, ['cat-file', 'blob', file.blob]))
          : ok(await objectText(root, snapshot.source.head, path))
    if (current._tag === 'Err') return current
    if (oldBytes.length > MAX_BYTES || current.value.length > MAX_BYTES) return err('TooLarge')
    if (oldBytes.includes(0) || current.value.includes(0)) return err('Binary')
    const decode = new TextDecoder('utf-8', { fatal: true })
    return Promise.resolve()
      .then(() =>
        ok({
          path,
          generation: hash(Buffer.concat([oldBytes, Buffer.from([0]), current.value])),
          oldText: decode.decode(oldBytes),
          newText: decode.decode(current.value),
        }),
      )
      .catch((cause: unknown) => {
        if (cause instanceof TypeError) return err('Binary')
        throw cause
      })
  })
}
