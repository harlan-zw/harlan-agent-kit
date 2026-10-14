import type { TerminalFailure, TerminalLaunch, TerminalSession } from './terminal-protocol.ts'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

export interface TerminalIntent {
  decision: { _tag: 'Pending' } | { _tag: 'Rejected'; reason: TerminalFailure } | { _tag: 'Accepted' }
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
export async function initializeTerminalStorage(directory: string, bootId: string) {
  await mkdir(join(directory, 'sessions'), { recursive: true, mode: 0o700 })
  const file = join(directory, 'host.json')
  const handle = await open(file, 'wx', 0o600).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'EEXIST') return null
    throw cause
  })
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
  const id = createHash('sha256').update(`${hostId}:${launch.requestId}`).digest('hex').slice(0, 24)
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        projectId: launch.projectId,
        provider: launch.provider,
      }),
    )
    .digest('hex')
  return { id, fingerprint, unit: `wolfstar-terminal-${id}.service` }
}
export async function readTerminalIntents(directory: string): Promise<TerminalIntent[]> {
  const entries = await readdir(join(directory, 'sessions'), {
    withFileTypes: true,
  })
  const intents: TerminalIntent[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f\d]{24}$/.test(entry.name)) continue
    const content = await readFile(join(directory, 'sessions', entry.name, 'intent.json'), 'utf8').catch(
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return null
        throw cause
      },
    )
    if (content === null) continue
    const intent = JSON.parse(content) as TerminalIntent
    if (
      intent.protocol !== 1 ||
      intent.session.id !== entry.name ||
      intent.unit !== `wolfstar-terminal-${entry.name}.service`
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
  const content = await readFile(join(directory, 'sessions', intent.session.id, 'prepared.json'), 'utf8').catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return null
      throw cause
    },
  )
  if (content === null) return null
  const prepared = JSON.parse(content) as TerminalPrepared
  if (
    prepared.generation !== intent.session.generation ||
    typeof prepared.worktree !== 'string' ||
    !prepared.worktree.startsWith('/') ||
    typeof prepared.invocationId !== 'string'
  ) {
    throw new Error('Invalid terminal Worktree record')
  }
  return prepared
}
