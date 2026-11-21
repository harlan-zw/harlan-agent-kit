import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/** Permission for an automatic sweep, never for a maintainer's explicit dismissal. */
export function canResolveThread(rootBody: string): boolean {
  // Selection checks race with maintainer edits. All Service findings stay open.
  return rootBody.trim() !== '' && !/<!--\s*review-finding:/i.test(rootBody)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = canResolveThread(readFileSync(0, 'utf8')) ? 0 : 1
