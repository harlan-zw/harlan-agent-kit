import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import process from 'node:process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const maximumBytes = 8_000_000
export type ReviewRevisionBlob
  = | { _tag: 'Missing' }
    | { _tag: 'Text', oid: string, bytes: number, text: string }
    | { _tag: 'Binary' | 'Symlink', oid: string, bytes: number }
export type ReviewRevisionEvidence = { _tag: 'Available', baseSha: string, headSha: string, mergeBaseSha: string, diff: string, files: Record<string, { base: ReviewRevisionBlob, head: ReviewRevisionBlob }> } | { _tag: 'Unavailable', reason: string }

/** Fixed object reads only. Production calls this collector inside the isolated namespace. */
export async function collectReviewEvidence(workspace: string, baseSha: string, headSha: string): Promise<ReviewRevisionEvidence> {
  if (![baseSha, headSha].every(sha => /^[a-f0-9]{40}$/.test(sha)))
    throw new Error('The Review evidence requires exact commit SHA values.')
  const git = async (args: string[], limit = maximumBytes): Promise<Buffer> => {
    const result = await execute('/usr/bin/git', ['--no-pager', '-C', workspace, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', ...args], { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' }, encoding: 'buffer', maxBuffer: limit, timeout: 10_000 })
    return result.stdout
  }
  const mergeBaseSha = (await git(['merge-base', baseSha, headSha], 100)).toString('utf8').trim()
  if (!/^[a-f0-9]{40}$/.test(mergeBaseSha))
    throw new Error('The Review merge base is invalid.')
  const paths = (await git(['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', mergeBaseSha, headSha, '--'], 256_000)).toString('utf8').split('\0').filter(Boolean)
  if (paths.length > 500)
    return { _tag: 'Unavailable', reason: 'The Review evidence exceeds 500 changed files.' }
  if (paths.some(path => path.length > 500))
    return { _tag: 'Unavailable', reason: 'A changed file path exceeds the Review address limit.' }
  const tree = async (sha: string): Promise<Map<string, { oid: string, regular: boolean }>> => {
    const listing = (await git(['ls-tree', '-r', '-z', sha, '--'], 2_000_000)).toString('utf8')
    return new Map(listing.split('\0').filter(Boolean).flatMap((entry) => {
      const match = /^(\d{6}) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry)
      return match ? [[match[3]!, { oid: match[2]!, regular: ['100644', '100755'].includes(match[1]!) }] as const] : []
    }))
  }
  const base = await tree(mergeBaseSha)
  const head = await tree(headSha)
  const files: ReviewRevisionEvidence & { _tag: 'Available' } = { _tag: 'Available', baseSha, headSha, mergeBaseSha, diff: '', files: Object.create(null) as Record<string, { base: ReviewRevisionBlob, head: ReviewRevisionBlob }> }
  let bytes = 0
  for (const path of paths) {
    const read = async (entries: Map<string, { oid: string, regular: boolean }>): Promise<ReviewRevisionBlob> => {
      const entry = entries.get(path)
      if (entry === undefined)
        return { _tag: 'Missing' }
      const size = Number((await git(['cat-file', '-s', entry.oid], 100)).toString('utf8').trim())
      if (!Number.isSafeInteger(size) || size < 0)
        throw new Error('The changed revision blob size is invalid.')
      if (!entry.regular)
        return { _tag: 'Symlink', oid: entry.oid, bytes: size }
      const prefix = await git(['cat-file', 'blob', entry.oid], 8192).catch((error: unknown) => {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && 'stdout' in error && Buffer.isBuffer(error.stdout))
          return error.stdout.subarray(0, 8192)
        throw error
      })
      if (prefix.includes(0))
        return { _tag: 'Binary', oid: entry.oid, bytes: size }
      if (size > 1_000_000 || bytes + size > maximumBytes)
        throw new Error('Changed text revision blobs exceed the Review evidence byte limit.')
      const value = size <= 8192 ? prefix : await git(['cat-file', 'blob', entry.oid], 1_000_000)
      if (value.includes(0))
        return { _tag: 'Binary', oid: entry.oid, bytes: size }
      bytes += size
      return { _tag: 'Text', oid: entry.oid, bytes: size, text: value.toString('utf8') }
    }
    files.files[path] = { base: await read(base), head: await read(head) }
  }
  const textPaths = paths.filter(path => [files.files[path]!.base, files.files[path]!.head].every(blob => blob._tag === 'Text' || blob._tag === 'Missing'))
  const metadata = await git(['diff', '--raw', '--no-abbrev', '--no-ext-diff', '--no-textconv', '--no-renames', mergeBaseSha, headSha, '--'])
  const patch = textPaths.length === 0 ? Buffer.alloc(0) : await git(['diff', '--text', '--no-ext-diff', '--no-textconv', '--no-renames', mergeBaseSha, headSha, '--', ...textPaths])
  files.diff = Buffer.concat([metadata, Buffer.from('\n'), patch]).toString('utf8')
  if (Buffer.byteLength(JSON.stringify(files)) > maximumBytes)
    return { _tag: 'Unavailable', reason: 'The serialized Review evidence exceeds 8000000 bytes.' }
  return files
}

if (process.argv[2] === '--review-evidence') {
  const [workspace, baseSha, headSha] = process.argv.slice(3)
  if (!workspace || !baseSha || !headSha)
    throw new Error('The Review evidence needs a worktree and exact revisions.')
  collectReviewEvidence(workspace, baseSha, headSha).then(value => process.stdout.write(JSON.stringify(value))).catch((error: unknown) => {
    process.stderr.write(error instanceof Error ? error.message.slice(0, 500) : 'The Review evidence failed.')
    process.exitCode = 1
  })
}
