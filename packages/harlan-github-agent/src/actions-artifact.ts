import type { Buffer } from 'node:buffer'
import { inflateRawSync } from 'node:zlib'

/**
 * Reads the text files of one GitHub Actions artifact archive.
 *
 * A failed run often writes its evidence to an artifact, not to the job log.
 * The worker GitHub CLI reads public repositories only, so on a private
 * repository GitHub answers it 404 and that evidence never reached the Agent
 * (gscdump.com Baseline repair, 2026-11-12). The controller downloads the
 * archive with its own installation token and hands over the text instead.
 */
export type ArtifactText
  = | { _tag: 'Read', files: ArtifactFile[] }
    | { _tag: 'Unreadable', reason: string }

export interface ArtifactFile {
  path: string
  /** Null when the file is binary or larger than any prompt could carry. */
  text: string | null
  /** True when only the end of the file is kept. */
  truncated: boolean
}

const END_OF_DIRECTORY = 0x06054B50
const DIRECTORY_ENTRY = 0x02014B50
const LOCAL_ENTRY = 0x04034B50
const MAXIMUM_INFLATED_BYTES = 1024 * 1024

function endOfDirectory(archive: Buffer): number {
  // The record is 22 bytes plus a comment of at most 65535 bytes.
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 22 - 0xFFFF); offset--) {
    if (archive.readUInt32LE(offset) === END_OF_DIRECTORY)
      return offset
  }
  return -1
}

function inflate(method: number, data: Buffer): Buffer | null {
  if (method === 0)
    return data
  if (method !== 8)
    return null
  try {
    return inflateRawSync(data, { maxOutputLength: MAXIMUM_INFLATED_BYTES })
  }
  catch {
    // A corrupt or oversized entry is one unreadable file, not a failed read.
    return null
  }
}

/** Pure. Keeps the last `budget` characters of each text file, where a failure is written. */
export function readArtifactText(archive: Buffer, budget: number): ArtifactText {
  const end = archive.length >= 22 ? endOfDirectory(archive) : -1
  if (end < 0)
    return { _tag: 'Unreadable', reason: 'The artifact is not a zip archive.' }
  const count = archive.readUInt16LE(end + 10)
  let cursor = archive.readUInt32LE(end + 16)
  const files: ArtifactFile[] = []
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== DIRECTORY_ENTRY)
      return { _tag: 'Unreadable', reason: 'The artifact zip directory is damaged.' }
    const method = archive.readUInt16LE(cursor + 10)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const path = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    cursor += 46 + nameLength + extraLength + commentLength
    if (path.endsWith('/'))
      continue
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== LOCAL_ENTRY)
      return { _tag: 'Unreadable', reason: 'The artifact zip entry is damaged.' }
    const start = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28)
    const bytes = inflate(method, archive.subarray(start, start + compressedSize))
    if (bytes === null || bytes.includes(0)) {
      files.push({ path, text: null, truncated: false })
      continue
    }
    const text = bytes.toString('utf8')
    files.push(text.length > budget
      ? { path, text: text.slice(-budget), truncated: true }
      : { path, text, truncated: false })
  }
  return { _tag: 'Read', files }
}
