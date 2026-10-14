import type { Result } from './result.ts'
import type { TerminalDiffError, TerminalFileDiff } from './terminal-diff.ts'
import { createHash } from 'node:crypto'
import { err, ok } from './result.ts'

interface Target {
  repository: string
  number: number
}
interface Revision extends Target {
  base: string
  head: string
}
interface File {
  path: string
  previousPath: string
  status: string
}
interface Snapshot extends Revision {
  id: string
  mergeBase: string
  files: File[]
  expiresAt: number
}
export interface PullRequestDiffInventory {
  id: string
  base: string
  source: { _tag: 'Comparison'; base: string; head: string }
  files: { path: string; status: string }[]
  coverage: { _tag: 'Complete' } | { _tag: 'Incomplete'; reason: 'GitHubFileLimit' }
}
interface Dependencies {
  read: (
    repository: string,
    route: string,
    parameters: Record<string, string | number>,
    signal: AbortSignal,
  ) => Promise<unknown>
  now: () => number
  log: (message: string) => void
}
const maximumBytes = 2 * 1024 * 1024
const maximumTreeDepth = 32
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(value)
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
function path(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.startsWith('/') &&
    !value.includes('\0') &&
    value.split('/').every((part) => part !== '..' && part !== '.' && part !== '')
  )
}
const target = (value: Target) =>
  /^[\w.-]+\/[\w.-]+$/.test(value.repository) && Number.isSafeInteger(value.number) && value.number > 0
function malformed(): never {
  throw new Error('GitHub diff response is invalid.')
}

/** Reads immutable Git objects. A later force-push invalidates the snapshot before any contents are returned. */
export function createPullRequestDiffSource(dependencies: Dependencies) {
  const snapshots = new Map<string, Snapshot>()
  function expire() {
    for (const [id, snapshot] of snapshots) {
      if (snapshot.expiresAt <= dependencies.now()) snapshots.delete(id)
    }
  }
  async function boundary<T>(
    operation: () => Promise<Result<T, TerminalDiffError>>,
  ): Promise<Result<T, TerminalDiffError>> {
    return operation().catch(() => {
      // GitHub errors can contain request credentials. Report the boundary without their body.
      dependencies.log('Pull request diff is unavailable.')
      return err('Unavailable')
    })
  }
  async function read(value: Target, route: string, parameters: Record<string, string | number>, signal: AbortSignal) {
    const [owner, repo] = value.repository.split('/')
    return dependencies.read(value.repository, route, { owner: owner!, repo: repo!, ...parameters }, signal)
  }
  async function revision(value: Target, signal: AbortSignal) {
    const response = await read(value, 'GET /repos/{owner}/{repo}/pulls/{number}', { number: value.number }, signal)
    if (
      !record(response) ||
      !record(response.base) ||
      !record(response.head) ||
      !sha(response.base.sha) ||
      !sha(response.head.sha) ||
      !Number.isSafeInteger(response.changed_files) ||
      Number(response.changed_files) < 0
    ) {
      return malformed()
    }
    return { base: response.base.sha, head: response.head.sha, count: Number(response.changed_files) }
  }
  function matches(expected: Revision, current: { base: string; head: string }) {
    return expected.base === current.base && expected.head === current.head
  }
  async function list(
    value: Revision,
    signal: AbortSignal,
  ): Promise<Result<PullRequestDiffInventory, TerminalDiffError>> {
    if (!target(value) || !sha(value.base) || !sha(value.head)) return err('InvalidRequest')
    expire()
    return boundary(async () => {
      const before = await revision(value, signal)
      if (!matches(value, before)) return err('Changed')
      const comparison = await read(
        value,
        'GET /repos/{owner}/{repo}/compare/{base}...{head}',
        { base: value.base, head: value.head, per_page: 1 },
        signal,
      )
      if (!record(comparison) || !record(comparison.merge_base_commit) || !sha(comparison.merge_base_commit.sha))
        return malformed()
      const mergeBase = comparison.merge_base_commit.sha
      const files: File[] = []
      let fileBytes = 0
      const seen = new Set<string>()
      const statuses: Record<string, string> = {
        added: 'A',
        removed: 'D',
        modified: 'M',
        renamed: 'R',
        copied: 'C',
        changed: 'M',
        unchanged: ' ',
      }
      for (let page = 1; page <= 30; page++) {
        const response = await read(
          value,
          'GET /repos/{owner}/{repo}/pulls/{number}/files',
          { number: value.number, per_page: 100, page },
          signal,
        )
        if (!Array.isArray(response) || response.length > 100) return malformed()
        for (const file of response) {
          if (
            !record(file) ||
            !path(file.filename) ||
            typeof file.status !== 'string' ||
            statuses[file.status] === undefined ||
            seen.has(file.filename) ||
            (file.status === 'renamed' && !path(file.previous_filename))
          ) {
            return malformed()
          }
          seen.add(file.filename)
          fileBytes +=
            Buffer.byteLength(file.filename) +
            Buffer.byteLength(typeof file.previous_filename === 'string' ? file.previous_filename : '')
          if (fileBytes > 1024 * 1024) return err('TooLarge')
          files.push({
            path: file.filename,
            previousPath: file.status === 'renamed' ? (file.previous_filename as string) : file.filename,
            status: statuses[file.status]!,
          })
        }
        if (response.length < 100) break
      }
      const after = await revision(value, signal)
      if (!matches(value, after) || after.count !== before.count) return err('Changed')
      if (files.length !== Math.min(before.count, 3000)) return err('Unavailable')
      const id = hash(JSON.stringify({ ...value, mergeBase, files }))
      if (snapshots.size >= 8) snapshots.delete(snapshots.keys().next().value!)
      snapshots.set(id, { ...value, id, mergeBase, files, expiresAt: dependencies.now() + 60000 })
      return ok({
        id,
        base: mergeBase,
        source: { _tag: 'Comparison' as const, base: mergeBase, head: value.head },
        files: files.map(({ path, status }) => ({ path, status })),
        coverage:
          before.count > files.length
            ? { _tag: 'Incomplete' as const, reason: 'GitHubFileLimit' as const }
            : { _tag: 'Complete' as const },
      })
    })
  }
  async function contents(
    value: Snapshot,
    commit: string,
    filename: string,
    signal: AbortSignal,
  ): Promise<Result<string, TerminalDiffError>> {
    const revision = await read(value, 'GET /repos/{owner}/{repo}/git/commits/{sha}', { sha: commit }, signal)
    if (!record(revision) || !record(revision.tree) || !sha(revision.tree.sha)) return malformed()
    let tree = revision.tree.sha
    const segments = filename.split('/')
    for (let index = 0; index < segments.length; index++) {
      const response = await read(value, 'GET /repos/{owner}/{repo}/git/trees/{sha}', { sha: tree }, signal)
      if (
        !record(response) ||
        response.truncated !== false ||
        !Array.isArray(response.tree) ||
        response.tree.length > 100000
      )
        return err('TooLarge')
      const entry = response.tree.find((entry) => record(entry) && entry.path === segments[index])
      if (!record(entry)) return err('Changed')
      if (!sha(entry.sha) || typeof entry.mode !== 'string') return malformed()
      if (entry.mode === '120000') return err('Symlink')
      if (index < segments.length - 1) {
        if (entry.type !== 'tree' || entry.mode !== '040000') return err('Unavailable')
        tree = entry.sha
        continue
      }
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) return err('Unavailable')
      if (!Number.isSafeInteger(entry.size) || Number(entry.size) < 0) return malformed()
      if (Number(entry.size) > maximumBytes) return err('TooLarge')
      const blob = await read(value, 'GET /repos/{owner}/{repo}/git/blobs/{sha}', { sha: entry.sha }, signal)
      if (
        !record(blob) ||
        blob.sha !== entry.sha ||
        blob.encoding !== 'base64' ||
        blob.size !== entry.size ||
        typeof blob.content !== 'string' ||
        blob.content.length > 3 * maximumBytes
      ) {
        return malformed()
      }
      const bytes = Buffer.from(blob.content, 'base64')
      if (bytes.byteLength !== blob.size) return malformed()
      if (bytes.includes(0)) return err('Binary')
      const decoded = (() => {
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        } catch {
          return undefined
        }
      })()
      return decoded === undefined ? err('Binary') : ok(decoded)
    }
    return err('Unavailable')
  }
  async function file(
    value: Target & { snapshot: string; path: string },
    signal: AbortSignal,
  ): Promise<Result<TerminalFileDiff, TerminalDiffError>> {
    if (!target(value) || !path(value.path) || !/^[a-f\d]{64}$/.test(value.snapshot)) return err('InvalidRequest')
    expire()
    const snapshot = snapshots.get(value.snapshot)
    if (!snapshot || snapshot.repository !== value.repository || snapshot.number !== value.number) return err('Changed')
    const selected = snapshot.files.find((file) => file.path === value.path)
    if (!selected) return err('InvalidRequest')
    // Each side reads one tree per segment. Bound their combined GitHub request cost.
    if ([selected.path, selected.previousPath].some((path) => path.split('/').length > maximumTreeDepth))
      return err('TooLarge')
    return boundary(async () => {
      if (!matches(snapshot, await revision(snapshot, signal))) return err('Changed')
      const [oldText, newText] = await Promise.all([
        selected.status === 'A'
          ? Promise.resolve(ok(''))
          : contents(snapshot, snapshot.mergeBase, selected.previousPath, signal),
        selected.status === 'D' ? Promise.resolve(ok('')) : contents(snapshot, snapshot.head, selected.path, signal),
      ])
      if (oldText._tag === 'Err') return oldText
      if (newText._tag === 'Err') return newText
      if (!matches(snapshot, await revision(snapshot, signal))) return err('Changed')
      return ok({
        path: value.path,
        generation: hash(`${snapshot.id}\0${value.path}\0${oldText.value}\0${newText.value}`),
        oldText: oldText.value,
        newText: newText.value,
      })
    })
  }
  return { list, file }
}
