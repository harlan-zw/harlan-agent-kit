import type { ReviewRevisionEvidence } from './review-evidence-cli.ts'
import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { createReviewStaticReader } from './review-static.ts'

export const REVIEW_TOOLS = [
  { name: 'review_read', description: 'Page workspace files or immutable exact revision evidence. Use revision diff with empty path for the complete diff and changed-file metadata. Base means the triple-dot merge base. Follow nextOffset until truncated is false. Binary files and symlinks are unavailable.', inputSchema: { type: 'object', properties: { path: { type: 'string', maxLength: 500 }, revision: { type: 'string', enum: ['workspace', 'diff', 'base', 'head'] }, offset: { type: 'integer', minimum: 0, maximum: 32_000_000 } }, required: ['path'], additionalProperties: false } },
  { name: 'review_search', description: 'Search bounded worktree files for literal text.', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['text'], additionalProperties: false } },
  { name: 'review_proof', description: 'Spend this Review Task one controller Node invocation. Failure cannot be edited or retried. Use a standalone TypeScript probe of a workspace exported API. Setup and other runtimes are unsupported.', inputSchema: { type: 'object', properties: { planId: { const: 'node-typescript', type: 'string' }, source: { type: 'string', minLength: 1, maxLength: 20_000 } }, required: ['planId', 'source'], additionalProperties: false } },
] as const

export function createReviewTools(options: { workspace: string, evidencePath?: string, proof: (input: unknown) => Promise<unknown> }): { call: (name: unknown, input: unknown) => Promise<unknown> } {
  const reader = createReviewStaticReader(options.workspace)
  const evidence = async (): Promise<ReviewRevisionEvidence> => {
    if (options.evidencePath === undefined)
      return { _tag: 'Unavailable', reason: 'Exact revision evidence is unavailable.' }
    const file = await open(options.evidencePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const metadata = await file.stat()
      if (!metadata.isFile() || metadata.size > 8_000_000 || await realpath(`/proc/self/fd/${file.fd}`) !== options.evidencePath)
        throw new Error('The Review evidence must use a bounded immutable regular file.')
      return JSON.parse(await file.readFile('utf8')) as ReviewRevisionEvidence
    }
    finally { await file.close() }
  }
  return {
    async call(name, input) {
      if (typeof input !== 'object' || input === null || Array.isArray(input))
        return { _tag: 'Refused', reason: 'The Review tool requires an object.' }
      const record = input as Record<string, unknown>
      if (name === 'review_read') {
        if (record.revision === undefined || record.revision === 'workspace')
          return reader.read(record.path, record.offset)
        if (!['diff', 'base', 'head'].includes(String(record.revision)) || typeof record.path !== 'string' || record.path.length > 500 || record.path.startsWith('/') || record.path.split('/').includes('..'))
          return { _tag: 'Refused', reason: 'Use an exact revision and a relative changed file path.' }
        const offset = record.offset ?? 0
        if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 32_000_000)
          return { _tag: 'Refused', reason: 'The read offset must be between 0 and 32000000 bytes.' }
        const artifact = await evidence()
        if (artifact._tag === 'Unavailable')
          return artifact
        const text = record.revision === 'diff' && record.path === '' ? artifact.diff : artifact.files[record.path]?.[record.revision as 'base' | 'head']
        if (typeof text !== 'string')
          return { _tag: 'Refused', reason: 'This revision has no supported changed file at that path.' }
        const bytes = Buffer.from(text)
        let end = Math.min(Number(offset) + 16_000, bytes.length)
        while (end > Number(offset) && end < bytes.length && (bytes[end]! & 0xC0) === 0x80)
          end--
        const truncated = end < bytes.length
        return { _tag: 'Read', text: bytes.subarray(Number(offset), end).toString('utf8'), truncated, ...(truncated ? { nextOffset: end } : {}), baseSha: artifact.baseSha, headSha: artifact.headSha, mergeBaseSha: artifact.mergeBaseSha }
      }
      if (name === 'review_search')
        return reader.search(record.text)
      if (name === 'review_proof')
        return options.proof(input)
      return { _tag: 'Refused', reason: 'This Review tool is unavailable.' }
    },
  }
}
