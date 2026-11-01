import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export type BrowserSetupRuntime
  = | { _tag: 'Available', path: string, version: string, digest: string }
    | { _tag: 'Unavailable', reason: string }

/** The managed installer supplies the runtime. Missing setup never blocks unrelated commands. */
export async function resolveBrowserSetupRuntime(home: string): Promise<BrowserSetupRuntime> {
  const unavailable = (): BrowserSetupRuntime => ({ _tag: 'Unavailable', reason: 'Browser setup needs the managed Node 24 runtime. Run the trusted Agent tool sync.' })
  const root = join(home, '.local/share/harlan-agent-kit/tools')
  const receipt = join(root, 'browser-node.json')
  const binary = join(root, 'bin/browser-node')
  const metadata = await lstat(receipt).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return undefined
    throw error
  })
  if (metadata === undefined || !metadata.isFile() || metadata.size > 16 * 1024
    || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0 || await realpath(receipt) !== receipt) {
    return unavailable()
  }
  let value: unknown
  try {
    value = JSON.parse(await readFile(receipt, 'utf8'))
  }
  catch (error) {
    if (error instanceof SyntaxError)
      return unavailable()
    throw error
  }
  if (typeof value !== 'object' || value === null)
    return unavailable()
  const record = value as Record<string, unknown>
  if (typeof record.tag !== 'string' || !/^v24\.\d+\.\d+$/.test(record.tag)
    || typeof record.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(record.digest)) {
    return unavailable()
  }
  const runtime = await lstat(binary).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return undefined
    throw error
  })
  if (runtime === undefined || !runtime.isFile() || (runtime.mode & 0o111) === 0 || await realpath(binary) !== binary)
    return unavailable()
  const file = await open(binary, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const header = Buffer.alloc(4)
    await file.read(header, 0, 4, 0)
    if (header.toString('hex') !== '7f454c46')
      return unavailable()
  }
  finally {
    await file.close()
  }
  const version = await execute(binary, ['--version'], { timeout: 3000 }).then(result => result.stdout.trim()).catch((error: unknown) => {
    // An installed optional runtime may be damaged. Browser use reports its setup requirement.
    if (typeof error === 'object' && error !== null && ('code' in error || 'signal' in error))
      return undefined
    throw error
  })
  return version === record.tag
    ? { _tag: 'Available', path: binary, version, digest: record.digest }
    : unavailable()
}
