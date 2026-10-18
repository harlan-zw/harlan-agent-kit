import type {
  TerminalExit,
  TerminalFailure,
  TerminalLaunch,
  TerminalSession,
} from './terminal-protocol.ts'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeTerminalExit } from './terminal-protocol.ts'

export interface TerminalIntent {
  admission: { _tag: 'Regular', requestId: string } | { _tag: 'ManualOverride', requestId: string }
  queueOrder: number
  manualAttempts: Record<string, { _tag: 'Pending' } | { _tag: 'Refused', reason: string } | { _tag: 'Accepted' }>
  decision:
    | { _tag: 'Pending' }
    | { _tag: 'Queued', reason: string }
    | { _tag: 'Rejected', reason: TerminalFailure }
    | { _tag: 'Accepted' }
    | { _tag: 'Cancelled' }
  protocol: 1
  fingerprint: string
  launch: TerminalLaunch
  session: TerminalSession
  unit: string
  helperToken: string
  reservationId: string | null
  invocationId: string | null
  controlGroup: string | null
  helperDigest: string
}
export async function writeTerminalJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  await handle.writeFile(JSON.stringify(value))
  await handle.sync()
  await handle.close()
  await rename(temporary, path)
  const directory = await open(join(path, '..'), 'r')
  await directory.sync()
  await directory.close()
}
export async function writeTerminalExit(directory: string, sessionId: string, generation: string, exit: TerminalExit) {
  if (!/^[a-f\d]{24}$/.test(sessionId) || !generation || generation.length > 256)
    throw new Error('Invalid terminal session identity')
  const normalized = normalizeTerminalExit({ exitCode: exit.code, signal: exit.signal })
  if (!normalized)
    throw new Error('Invalid terminal process exit')
  await writeTerminalJson(
    join(directory, 'sessions', sessionId, 'exit.json'),
    { generation, exit: normalized },
  )
}
export async function readTerminalExit(directory: string, sessionId: string, generation: string): Promise<TerminalExit | undefined> {
  if (!/^[a-f\d]{24}$/.test(sessionId) || !generation || generation.length > 256)
    return undefined
  const content = await readFile(
    join(directory, 'sessions', sessionId, 'exit.json'),
    'utf8',
  ).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT')
      return null
    throw cause
  })
  if (content === null)
    return undefined
  try {
    const value = JSON.parse(content) as { generation?: unknown, exit?: unknown }
    if (value.generation !== generation)
      return undefined
    const exit = value.exit
    if (typeof exit !== 'object' || exit === null || Array.isArray(exit))
      return undefined
    const record = exit as Record<string, unknown>
    return normalizeTerminalExit({ exitCode: record.code, signal: record.signal })
  }
  catch {
    return undefined
  }
}
export async function initializeTerminalStorage(
  directory: string,
  bootId: string,
) {
  await mkdir(join(directory, 'sessions'), { recursive: true, mode: 0o700 })
  const file = join(directory, 'host.json')
  const handle = await open(file, 'wx', 0o600).catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === 'EEXIST')
        return null
      throw cause
    },
  )
  if (handle) {
    await handle.writeFile(
      JSON.stringify({
        hostId: randomUUID(),
        authSecret: randomUUID() + randomUUID(),
      }),
    )
    await handle.sync()
    await handle.close()
  }
  const host = JSON.parse(await readFile(file, 'utf8')) as {
    hostId: string
    authSecret: string
  }
  if (typeof host.hostId !== 'string' || typeof host.authSecret !== 'string')
    throw new Error('Invalid terminal host storage')
  return { ...host, bootId }
}
export function terminalIdentity(hostId: string, launch: TerminalLaunch) {
  const id = createHash('sha256')
    .update(`${hostId}:${launch.requestId}`)
    .digest('hex')
    .slice(0, 24)
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        projectId: launch.projectId,
        provider: launch.provider,
        ...(launch.initialPrompt === undefined ? {} : { initialPrompt: launch.initialPrompt }),
      }),
    )
    .digest('hex')
  return { id, fingerprint, unit: `harlan-terminal-${id}.service` }
}
export async function readTerminalIntents(
  directory: string,
): Promise<TerminalIntent[]> {
  const entries = await readdir(join(directory, 'sessions'), {
    withFileTypes: true,
  })
  const intents: TerminalIntent[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f\d]{24}$/.test(entry.name))
      continue
    const content = await readFile(
      join(directory, 'sessions', entry.name, 'intent.json'),
      'utf8',
    ).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT')
        return null
      throw cause
    })
    if (content === null)
      continue
    const intent = JSON.parse(content) as TerminalIntent
    // Existing durable sessions predate manual admission. They always used their original Regular request.
    if (intent.admission === undefined)
      intent.admission = { _tag: 'Regular', requestId: intent.launch.requestId }
    if (intent.manualAttempts === undefined)
      intent.manualAttempts = {}
    if (intent.queueOrder === undefined)
      intent.queueOrder = 0
    if (
      intent.protocol !== 1
      || intent.session.id !== entry.name
      || intent.unit !== `harlan-terminal-${entry.name}.service`
      || !['Regular', 'ManualOverride'].includes(intent.admission._tag)
      || typeof intent.admission.requestId !== 'string'
      || intent.admission.requestId.length === 0
      || intent.admission.requestId.length > 256
      || !Number.isSafeInteger(intent.queueOrder)
      || intent.queueOrder < 0
    ) {
      throw new Error('Invalid terminal session storage')
    }
    intents.push(intent)
  }
  return intents
}
export interface TerminalPrepared {
  generation: string
  invocationId: string
  worktree: string
}
export async function readTerminalPrepared(
  directory: string,
  intent: TerminalIntent,
): Promise<TerminalPrepared | null> {
  const content = await readFile(
    join(directory, 'sessions', intent.session.id, 'prepared.json'),
    'utf8',
  ).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT')
      return null
    throw cause
  })
  if (content === null)
    return null
  const prepared = JSON.parse(content) as TerminalPrepared
  if (
    prepared.generation !== intent.session.generation
    || typeof prepared.worktree !== 'string'
    || !prepared.worktree.startsWith('/')
    || typeof prepared.invocationId !== 'string'
  ) {
    throw new Error('Invalid terminal Worktree record')
  }
  return prepared
}
