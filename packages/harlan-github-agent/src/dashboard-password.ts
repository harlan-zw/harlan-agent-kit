import type { Result } from './result.ts'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { err, ok } from './result.ts'

export async function loadDashboardPassword(path: string): Promise<Result<string, string>> {
  const password = (await readFile(path, 'utf8')).trimEnd()
  return Buffer.byteLength(password) < 32
    ? err('The dashboard password file must contain at least 32 bytes.')
    : ok(password)
}
