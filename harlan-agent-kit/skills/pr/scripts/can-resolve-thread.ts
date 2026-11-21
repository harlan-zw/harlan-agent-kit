import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/** Permission for an automatic sweep, never for a maintainer's explicit dismissal. */
export function canResolveThread(rootBody: string, response: unknown, authorType: unknown): boolean {
  // Selection checks race with maintainer edits. All Service findings stay open.
  return rootBody.trim() !== '' && !/<!--\s*review-finding:/i.test(rootBody)
    && (response === 'Fixed' || (authorType === 'Bot' && (response === 'Answered' || response === 'Follow-up')))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = JSON.parse(readFileSync(0, 'utf8')) as { body?: unknown, user?: { type?: unknown } | null } | null
  process.exitCode = typeof root?.body === 'string' && canResolveThread(root.body, process.argv[2], root.user?.type) ? 0 : 1
}
