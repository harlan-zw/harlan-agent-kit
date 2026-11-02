import type { FileHandle } from 'node:fs/promises'
import type { AgentSandbox } from './agent-sandbox.ts'
import type { VitalsComparisonRequest, VitalsComparisonResult } from './vitals-comparison.ts'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, open, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { redactSecrets } from './agent-activity.ts'
import { parseVitalsComparisonRequest, parseVitalsComparisonResult, vitalsComparisonInstructions } from './vitals-comparison.ts'

export const VITALS_EVIDENCE_GUEST_DIRECTORY = '/run/agent/vitals-evidence'

/** The standalone source and emitted entry use no repository imports at runtime. */
export function vitalsComparisonScript(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './vitals-comparison.ts' : '../vitals-comparison.mjs', import.meta.url))
}

async function checkedDirectory(path: string): Promise<FileHandle> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const metadata = await directory.stat()
  if (metadata.uid !== process.getuid?.() || (metadata.mode & 0o022) !== 0) {
    await directory.close()
    throw new Error('The performance evidence directory must belong to the controller and reject other writers.')
  }
  return directory
}

/**
 * Retain reports outside the repository and the disposable namespace.
 * Every child lookup uses an already-open parent, so replacing a path cannot redirect a host write.
 */
export async function createVitalsEvidenceDirectory(controllerHome: string, input: VitalsComparisonRequest): Promise<string> {
  const request = parseVitalsComparisonRequest(input)
  const home = await realpath(resolve(controllerHome))
  let parent = await checkedDirectory(home)
  let path = home
  try {
    for (const [index, segment] of ['scratch', 'vitals-review', request.taskId, request.id].entries()) {
      const child = `/proc/self/fd/${parent.fd}/${segment}`
      await mkdir(child, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST' || index === 3)
          throw error
      })
      const next = await checkedDirectory(child)
      await parent.close()
      parent = next
      path = join(path, segment)
    }
    const metadata = await parent.stat()
    if ((metadata.mode & 0o077) !== 0)
      throw new Error('The performance evidence directory must be private.')
    return path
  }
  finally {
    await parent.close()
  }
}

export function vitalsEvidenceInstructions(request: VitalsComparisonRequest): string {
  return vitalsComparisonInstructions(request, VITALS_EVIDENCE_GUEST_DIRECTORY)
}

/** Reads untrusted reports only inside the existing Agent boundary. No controller file path comes from a model. */
export async function inspectVitalsComparison(sandbox: AgentSandbox, request: VitalsComparisonRequest, signal: AbortSignal): Promise<VitalsComparisonResult> {
  const executed = await promisify(execFile)(sandbox.binary, [
    ...sandbox.args,
    '/run/agent/node',
    '--experimental-strip-types',
    vitalsComparisonScript(),
    'verify',
    JSON.stringify(request),
    VITALS_EVIDENCE_GUEST_DIRECTORY,
  ], { env: sandbox.environment, signal, timeout: 30_000, maxBuffer: 256 * 1024 })
    .then(value => ({ _tag: 'Ok' as const, value }))
    .catch((error: NodeJS.ErrnoException & { stderr?: unknown }) => ({ _tag: 'Err' as const, code: typeof error.code === 'string' || typeof error.code === 'number' ? String(error.code) : 'execution', detail: typeof error.stderr === 'string' ? redactSecrets(error.stderr).trim().slice(0, 500) : '' }))
  if (executed._tag === 'Err')
    return { _tag: 'Unavailable', requestId: request.id, reason: `The performance evidence validator could not run (${executed.code}).${executed.detail === '' ? '' : ` ${executed.detail}`}` }
  return Promise.resolve()
    .then(() => parseVitalsComparisonResult(JSON.parse(executed.value.stdout)))
    .catch(() => ({ _tag: 'Unavailable' as const, requestId: request.id, reason: 'The performance evidence validator returned an invalid result.' }))
}
