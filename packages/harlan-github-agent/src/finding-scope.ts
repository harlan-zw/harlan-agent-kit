import type { Result } from './result.ts'
import type { ReviewFinding } from './types.ts'
import { err, ok } from './result.ts'

/**
 * Who owns the fix for one finding, read from the diff the Review covered.
 *
 * `change` sits on a line this pull request added or changed, so Repair can
 * fix it on this branch before merge. `existing` sits on code already on the
 * base branch, so it becomes an issue. The controller computes it; an Agent
 * never supplies it. Absent means unknown, and an unknown scope never routes
 * a finding to Repair on the head.
 */
export type FindingScope = 'change' | 'existing'

/** One file in the reviewed diff, reduced to the head lines it adds. */
export type ChangedFile
  = | { _tag: 'Changed', path: string, previousPath: string | null, added: ReadonlySet<number> }
    | { _tag: 'Removed', path: string }
    /** GitHub sent no patch for a file with additions: a binary or a very large file. */
    | { _tag: 'Unreadable', path: string }

export interface ChangedLines {
  files: readonly ChangedFile[]
  /** False when GitHub may have cut the file list, so a missing path proves nothing. */
  complete: boolean
}

/** GitHub lists at most this many files in one comparison. */
const comparisonFileLimit = 300

/** The head line numbers one unified diff patch adds or changes. */
export function addedHeadLines(patch: string): ReadonlySet<number> {
  const added = new Set<number>()
  let line: number | null = null
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk !== null) {
      line = Number(hunk[1])
      continue
    }
    if (line === null || text.startsWith('-') || text.startsWith('\\'))
      continue
    if (text.startsWith('+'))
      added.add(line)
    line++
  }
  return added
}

/**
 * Where one finding sits relative to the reviewed diff, or undefined when the diff cannot say.
 *
 * Only an added line is `change`. A context line in a hunk is code the base
 * branch already had, so it reads `existing`.
 */
export function findingScope(location: { path: string, line: number | null }, diff: ChangedLines | null): FindingScope | undefined {
  if (diff === null || location.line === null || !Number.isSafeInteger(location.line) || location.line <= 0)
    return undefined
  const file = diff.files.find(file => file.path === location.path)
  if (file === undefined) {
    // The old path of a renamed file names code this change moved.
    if (diff.files.some(file => file._tag === 'Changed' && file.previousPath === location.path))
      return undefined
    return diff.complete ? 'existing' : undefined
  }
  if (file._tag !== 'Changed')
    return undefined
  return file.added.has(location.line) ? 'change' : 'existing'
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses the `files` of one GitHub comparison into the lines each file adds.
 *
 * A rename or mode change without a patch adds no line. A file with
 * additions and no patch is unreadable, so its findings stay unknown.
 */
export function changedLinesFromComparison(data: unknown): Result<ChangedLines, string> {
  if (!record(data) || !Array.isArray(data.files))
    return err('GitHub sent a comparison without a file list.')
  const files: ChangedFile[] = []
  for (const file of data.files) {
    if (!record(file) || typeof file.filename !== 'string' || typeof file.status !== 'string' || typeof file.additions !== 'number')
      return err('GitHub sent a comparison file without a name, status, or line count.')
    const path = file.filename
    if (file.status === 'removed') {
      files.push({ _tag: 'Removed', path })
      continue
    }
    const previousPath = typeof file.previous_filename === 'string' ? file.previous_filename : null
    if (typeof file.patch === 'string')
      files.push({ _tag: 'Changed', path, previousPath, added: addedHeadLines(file.patch) })
    else if (file.additions === 0)
      files.push({ _tag: 'Changed', path, previousPath, added: new Set() })
    else
      files.push({ _tag: 'Unreadable', path })
  }
  return ok({ files, complete: files.length < comparisonFileLimit })
}

/**
 * Stores each Logged finding's scope on the finding, computed from the reviewed diff.
 *
 * An unknown scope stores nothing, so a reader treats it exactly like a run
 * recorded before scope existed.
 */
export function withFindingScopes(findings: readonly ReviewFinding[], diff: ChangedLines | null): ReviewFinding[] {
  return findings.map((finding) => {
    if (finding._tag !== 'Logged')
      return finding
    const { scope: _stale, ...details } = finding.details
    const scope = findingScope(details.location, diff)
    return { ...finding, details: scope === undefined ? details : { ...details, scope } }
  })
}
