import { createReviewStaticReader } from './review-static.ts'

export const REVIEW_TOOLS = [
  { name: 'review_read', description: 'Read one bounded file inside the Review worktree.', inputSchema: { type: 'object', properties: { path: { type: 'string', maxLength: 500 } }, required: ['path'], additionalProperties: false } },
  { name: 'review_search', description: 'Search bounded worktree files for literal text.', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['text'], additionalProperties: false } },
  { name: 'review_proof', description: 'Spend this Review Task one controller Node invocation. Failure cannot be edited or retried. Use a standalone TypeScript probe of a workspace exported API. Setup and other runtimes are unsupported.', inputSchema: { type: 'object', properties: { planId: { const: 'node-typescript', type: 'string' }, source: { type: 'string', minLength: 1, maxLength: 20_000 } }, required: ['planId', 'source'], additionalProperties: false } },
] as const

export function createReviewTools(options: { workspace: string, proof: (input: unknown) => Promise<unknown> }): { call: (name: unknown, input: unknown) => Promise<unknown> } {
  const reader = createReviewStaticReader(options.workspace)
  return {
    async call(name, input) {
      if (typeof input !== 'object' || input === null || Array.isArray(input))
        return { _tag: 'Refused', reason: 'The Review tool requires an object.' }
      const record = input as Record<string, unknown>
      if (name === 'review_read')
        return reader.read(record.path)
      if (name === 'review_search')
        return reader.search(record.text)
      if (name === 'review_proof')
        return options.proof(input)
      return { _tag: 'Refused', reason: 'This Review tool is unavailable.' }
    },
  }
}
