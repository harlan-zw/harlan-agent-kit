import type { AgentEvent } from './agent-provider.ts'
import type { DesktopSessionGroup } from './desktop-session-process.ts'
import type { SessionFence, SessionProject, SessionTurn } from './session-protocol.ts'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { DESKTOP_MEMORY_PER_AGENT_GIB } from './desktop-protocol.ts'
import { acquireDesktopSessionClaim, releaseDesktopSessionClaim } from './desktop-session-claim.ts'
import { readDesktopSessionGroup, stopDesktopSessionGroup } from './desktop-session-process.ts'
import { discoverDesktopSessionProjects } from './desktop-session-projects.ts'
import { SESSION_PROTOCOL } from './session-protocol.ts'

export function createDesktopSessionClient(options: {
  api: <T>(path: string, body: unknown) => Promise<T | null>
  root: string
  capacity: string
  signal: AbortSignal
}) {
  const instanceId = randomUUID()
  let reported = 0
  let projects: SessionProject[] = []
  const fence = (turn: SessionTurn) => ({ instanceId, sessionId: turn.sessionId, turnId: turn.turnId, leaseToken: turn.leaseToken })
  const path = (action: string) => `/api/desktop/sessions/${action}`
  const api = options.api
  const active = new Map<string, () => void>()
  const livePath = (id: string) => join(options.root, 'sessions', id, 'live.json')
  const readLock = (id: string) => readFile(join(options.root, 'sessions', id, 'execution.lock'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
  const identity = (pid: number) => readFile(`/proc/${pid}/stat`, 'utf8').then(text => text.slice(text.lastIndexOf(')') + 2).split(' ')[19]).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
  const readClaim = (directory: string) => readFile(join(directory, 'claim.json'), 'utf8').then(text => JSON.parse(text) as { workspacePath: string, sessionId: string }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
  const releaseClaim = async (directory: string) => {
    const claim = await readClaim(directory)
    if (claim === null)
      return
    await releaseDesktopSessionClaim(claim.workspacePath, claim.sessionId)
    await rm(join(directory, 'claim.json'))
  }
  const reconcile = async (stops: SessionFence[]) => {
    for (const stopped of stops) {
      if (!/^[a-f0-9-]{36}$/.test(stopped.sessionId))
        continue
      const stop = active.get(stopped.turnId)
      if (stop !== undefined) {
        stop()
        continue
      }
      const ledger = await readFile(livePath(stopped.sessionId), 'utf8').then(text => JSON.parse(text) as DesktopSessionGroup & { turnId: string, leaseToken: string }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT')
          return null
        throw error
      })
      if (ledger === null && await readLock(stopped.sessionId) !== null)
        throw new Error('The previous session processes cannot be verified.')
      if (ledger !== null && (ledger.turnId !== stopped.turnId || ledger.leaseToken !== stopped.leaseToken))
        throw new Error('Another turn owns the session processes.')
      if (ledger !== null && ledger.turnId === stopped.turnId && ledger.leaseToken === stopped.leaseToken)
        await stopDesktopSessionGroup(ledger)
      await releaseClaim(join(options.root, 'sessions', stopped.sessionId, stopped.turnId))
      if (ledger !== null && ledger.turnId === stopped.turnId && ledger.leaseToken === stopped.leaseToken)
        await rm(join(options.root, 'sessions', stopped.sessionId, 'execution.lock'), { force: true })
      const result = await readFile(join(options.root, 'sessions', stopped.sessionId, stopped.turnId, 'result.json'), 'utf8').then(text => JSON.parse(text) as { workspacePath: string | null, providerSessionId: string | null }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT')
          return {}
        throw error
      })
      await api(path('complete'), { ...stopped, ...result, outcome: 'stopped' })
      if (ledger !== null && ledger.turnId === stopped.turnId && ledger.leaseToken === stopped.leaseToken)
        await rm(livePath(stopped.sessionId), { force: true })
    }
  }
  return {
    async report(): Promise<void> {
      if (Date.now() - reported > 30_000) {
        projects = await discoverDesktopSessionProjects(homedir())
        reported = Date.now()
      }
      const report = await api<{ accepted: boolean, stops: SessionFence[] }>(path('report'), { instanceId, protocol: SESSION_PROTOCOL, projects })
      await reconcile(report?.stops ?? [])
    },
    async claim(freeSlots: number): Promise<SessionTurn | null> {
      return await api<SessionTurn>(path('claim'), { instanceId, freeSlots })
    },
    async run(turn: SessionTurn): Promise<void> {
      if (![turn.sessionId, turn.turnId].every(id => /^[a-f0-9-]{36}$/.test(id)))
        throw new Error('The session turn identity is invalid.')
      const previous = await readFile(livePath(turn.sessionId), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT')
          return null
        throw error
      })
      if (previous !== null || await readLock(turn.sessionId) !== null) {
        await api(path('defer'), fence(turn))
        return
      }
      const directory = join(options.root, 'sessions', turn.sessionId, turn.turnId)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const input = join(directory, 'turn.json')
      await writeFile(input, JSON.stringify(turn), { mode: 0o600 })
      const extension = fileURLToPath(import.meta.url).endsWith('.ts') ? 'ts' : 'mjs'
      const executable = join(dirname(fileURLToPath(import.meta.url)), `desktop-session-execute.${extension}`)
      const child = spawn(options.capacity, ['run', turn.turnId, String(DESKTOP_MEMORY_PER_AGENT_GIB), process.execPath, '--experimental-strip-types', executable, input], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      let stopped = false
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-8000)
      })
      const completion = new Promise<number>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', code => resolve(code ?? 1))
      })
      void completion.catch((error: unknown) => {
        console.error('Session child failed to start.', error)
      })
      let group: DesktopSessionGroup | null = child.pid === undefined ? null : { pid: child.pid, birth: await identity(child.pid) ?? '', members: await readDesktopSessionGroup(child.pid) }
      let stopping: Promise<void> | null = null
      let stopFailure: unknown = null
      const stop = () => {
        stopped = true
        stopping ??= (group === null ? Promise.resolve() : stopDesktopSessionGroup(group)).catch((error: unknown) => {
          stopFailure = error
          console.error('Session processes could not stop.', error)
        })
      }
      const captureGroup = async () => {
        if (group === null || stopping !== null)
          return
        const members = await readDesktopSessionGroup(group.pid)
        if (members.length > 0 && !members.some(member => (member.pid === group!.pid && member.birth === group!.birth) || group!.members.some(saved => saved.pid === member.pid && saved.birth === member.birth)))
          throw new Error('The session process group identity changed.')
        group = { ...group, members: [...group.members, ...members].filter((member, index, all) => all.findIndex(item => item.pid === member.pid && item.birth === member.birth) === index) }
        await writeFile(livePath(turn.sessionId), JSON.stringify({ ...fence(turn), ...group }), { mode: 0o600 })
      }
      options.signal.addEventListener('abort', stop, { once: true })
      active.set(turn.turnId, stop)
      const heartbeat = new AbortController()
      let renewed = Date.now()
      const watching = (async () => {
        while (!heartbeat.signal.aborted) {
          await delay(3000, undefined, { signal: heartbeat.signal }).catch((error: unknown) => {
            if (!heartbeat.signal.aborted)
              throw error
          })
          if (heartbeat.signal.aborted)
            return
          await captureGroup()
          if (Date.now() - renewed > 5 * 60_000) {
            const claim = await readClaim(directory)
            if (claim !== null)
              await acquireDesktopSessionClaim(claim.workspacePath, claim.sessionId)
            renewed = Date.now()
          }
          const state = await api<{ active: boolean, cancelled: boolean }>(path('heartbeat'), fence(turn))
          if (!state?.active || state.cancelled) {
            stop()
            return
          }
        }
      })().catch((error: unknown) => {
        console.error('Session heartbeat failed.', error)
        stop()
      })
      let seq = 0
      const teardown = async () => {
        heartbeat.abort()
        await watching
        stopping ??= group === null ? Promise.resolve() : stopDesktopSessionGroup(group)
        await stopping
        if (stopFailure !== null)
          throw stopFailure
        await completion
        await releaseClaim(directory)
      }
      let cleaned = false
      try {
        await captureGroup()
        if (options.signal.aborted)
          stop()
        for await (const line of createInterface({ input: child.stdout })) {
          await captureGroup()
          const event = JSON.parse(line) as AgentEvent
          if ('_tag' in event && event._tag as string === 'AtCapacity')
            continue
          const batch = { ...fence(turn), seq: ++seq, events: [event] }
          // The local journal keeps exact batches before acknowledging transport.
          await appendFile(join(directory, 'events.jsonl'), `${JSON.stringify(batch)}\n`, { mode: 0o600 })
          let answer: { accepted: boolean } | null = null
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              answer = await api<{ accepted: boolean }>(path('events'), batch)
              break
            }
            catch (error) {
              if (attempt === 2)
                throw error
              console.error('Retrying session event delivery.', error)
            }
          }
          if (!answer?.accepted) {
            stop()
            break
          }
        }
        const code = await completion
        await teardown()
        cleaned = true
        if (code === 75) {
          await api(path('defer'), fence(turn))
          return
        }
        const result = await readFile(join(directory, 'result.json'), 'utf8').then(text => JSON.parse(text) as { workspacePath: string | null, providerSessionId: string | null }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT' && code !== 0)
            return { workspacePath: turn.workspacePath, providerSessionId: turn.providerSessionId }
          throw error
        })
        await api(path('complete'), { ...fence(turn), ...result, outcome: stopped ? 'stopped' : code === 0 ? 'completed' : 'failed', ...(code !== 0 && !stopped ? { reason: `Desktop Agent stopped with status ${code}. ${stderr}` } : {}) })
      }
      finally {
        if (!cleaned) {
          stop()
          await teardown()
        }
        options.signal.removeEventListener('abort', stop)
        await rm(input, { force: true })
        active.delete(turn.turnId)
        await rm(livePath(turn.sessionId), { force: true })
        await rm(join(options.root, 'sessions', turn.sessionId, 'execution.lock'), { force: true })
      }
    },
  }
}
