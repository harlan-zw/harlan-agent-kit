#!/usr/bin/env node
import type { DesktopTurn } from './desktop-broker.ts'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { desktopCommand } from './desktop-worktree.ts'

async function main(): Promise<void> {
  const origin = process.env.HARLAN_GITHUB_AGENT_CONTROLLER_URL
  if (origin === undefined || !origin.startsWith('https://'))
    throw new Error('An HTTPS controller URL is required.')
  const password = (await readFile(process.env.HARLAN_GITHUB_AGENT_PASSWORD_FILE ?? join(homedir(), '.config/harlan-github-agent/dashboard-password'), 'utf8')).trim()
  const capacity = process.env.HARLAN_DESKTOP_CAPACITY_COMMAND ?? join(homedir(), '.local/bin/harlan-desktop-capacity')
  const root = process.env.HARLAN_DESKTOP_AGENT_ROOT ?? join(homedir(), '.local/share/harlan-github-agent/desktop')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const shutdown = new AbortController()
  process.once('SIGTERM', () => shutdown.abort())
  process.once('SIGINT', () => shutdown.abort())

  async function api<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'authorization': `Basic ${Buffer.from(`agent:${password}`).toString('base64')}`, 'origin': origin!, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok)
      throw new Error(`Controller request failed with status ${response.status}.`)
    return await response.json() as T
  }

  async function report(): Promise<boolean> {
    const state = JSON.parse(await desktopCommand(capacity, ['status'], root))
    const entries = Object.values(state.reservations) as Array<{ kind: string }>
    const requested = await api<{ memoryGiB: number | null }>('/api/desktop/report', {
      memoryGiB: state.memoryGiB,
      reservedGiB: state.reservedGiB,
      agents: entries.filter(entry => entry.kind === 'agent').length,
      actions: entries.filter(entry => entry.kind === 'actions').length,
    })
    if (requested.memoryGiB !== null)
      await desktopCommand(capacity, ['set', String(requested.memoryGiB)], root)
    return state.memoryGiB - state.reservedGiB >= 8
  }

  async function run(turn: DesktopTurn): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(turn.id))
      throw new Error('Desktop turn identity is invalid.')
    const directory = join(root, createHash('sha256').update(turn.request.taskId ?? turn.id).digest('hex'))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const input = join(directory, 'turn.json')
    await writeFile(input, JSON.stringify(turn), { mode: 0o600 })
    await rm(join(directory, 'result.json'), { force: true })
    const extension = fileURLToPath(import.meta.url).endsWith('.ts') ? 'ts' : 'mjs'
    const executable = join(dirname(fileURLToPath(import.meta.url)), `desktop-execute.${extension}`)
    const child = spawn(capacity, ['run', turn.id, '8', process.execPath, '--experimental-strip-types', executable, input], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-8000)
    })
    const stop = () => {
      child.kill('SIGTERM')
    }
    shutdown.signal.addEventListener('abort', stop, { once: true })
    const heartbeat = new AbortController()
    const watching = (async () => {
      while (!heartbeat.signal.aborted) {
        await delay(3000, undefined, { signal: heartbeat.signal }).catch((error: unknown) => {
          if (!heartbeat.signal.aborted)
            throw error
        })
        if (heartbeat.signal.aborted)
          return
        try {
          await report()
          const state = await api<{ active: boolean }>('/api/desktop/heartbeat', { id: turn.id })
          if (!state.active) {
            stop()
            return
          }
        }
        catch (error) {
          console.error(error)
          stop()
          return
        }
      }
    })()
    const completion = new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => resolve(code ?? 1))
    })
    try {
      for await (const line of createInterface({ input: child.stdout })) {
        const event: unknown = JSON.parse(line)
        // Capacity refusal is handled after exit, before any provider starts.
        if (typeof event === 'object' && event !== null && '_tag' in event && event._tag === 'AtCapacity')
          continue
        const answer = await api<{ accepted: boolean }>('/api/desktop/events', { id: turn.id, events: [event] })
        if (!answer.accepted)
          stop()
      }
      const code = await completion
      if (code === 75) {
        await api('/api/desktop/defer', { id: turn.id })
        return
      }
      const result = await readFile(join(directory, 'result.json'), 'utf8')
        .then(text => JSON.parse(text) as unknown)
        .catch((error: NodeJS.ErrnoException) => {
          if (code !== 0 && error.code === 'ENOENT')
            return null
          throw error
        })
      await api('/api/desktop/complete', { id: turn.id, result, failure: code === 0 ? null : `Desktop Agent stopped with status ${code}. ${stderr}` })
    }
    finally {
      stop()
      await completion
      heartbeat.abort()
      await watching
      shutdown.signal.removeEventListener('abort', stop)
    }
  }

  while (!shutdown.signal.aborted) {
    try {
      if (await report()) {
        const turn = await api<DesktopTurn | null>('/api/desktop/claim', {})
        if (turn !== null)
          await run(turn)
      }
    }
    catch (error) {
      console.error(error)
    }
    await delay(3000, undefined, { signal: shutdown.signal }).catch((error: unknown) => {
      if (!shutdown.signal.aborted)
        throw error
    })
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
