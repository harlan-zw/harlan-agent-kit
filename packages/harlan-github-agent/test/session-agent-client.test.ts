import type { SessionAgentTransport } from '../src/desktop-session-client.ts'
import type { SessionFence, SessionTurn } from '../src/session-protocol.ts'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { createDesktopSessionClient } from '../src/desktop-session-client.ts'
import { readDesktopSessionGroup } from '../src/desktop-session-process.ts'
import * as groupProcesses from '../src/desktop-session-process.ts'
import { createHostAgentPool } from '../src/host-capacity.ts'

const exec = promisify(execFile)
function transport(overrides: Partial<SessionAgentTransport> = {}): SessionAgentTransport {
  return {
    report: async () => ({ accepted: true, stops: [] }),
    claim: async () => null,
    heartbeat: async () => ({ active: true, cancelled: false }),
    events: async () => ({ accepted: true }),
    complete: async () => ({ accepted: true }),
    defer: async () => ({ accepted: true }),
    ...overrides,
  }
}
it('reports only the selected host home and fences every message by host', async () => {
  const home = await mkdtemp(join(tmpdir(), 'session-host-home-'))
  const repository = join(home, 'pkg', 'local-project')
  await mkdir(join(home, 'pkg'))
  await exec('git', ['init', repository])
  const calls: unknown[] = []
  const client = createDesktopSessionClient({
    host: 'hogwild',
    home,
    root: join(home, 'runtime'),
    signal: new AbortController().signal,
    transport: transport({
      report: async (input) => {
        calls.push(input)
        return { accepted: true, stops: [] }
      },
      claim: async (input) => {
        calls.push(input)
        return null
      },
    }),
  })
  try {
    await client.report()
    await client.claim(2)
    expect(calls[0]).toMatchObject({ host: 'hogwild', projects: [{ id: 'pkg/local-project', path: repository }] })
    expect(calls[1]).toMatchObject({ host: 'hogwild', freeSlots: 2 })
    await expect(client.run({ host: 'desktop' } as SessionTurn)).rejects.toThrow('another host')
  }
  finally { await rm(home, { recursive: true, force: true }) }
})
it('runs a Hogwild child with host credentials and releases capacity after actual teardown', async () => {
  const home = await mkdtemp(join(tmpdir(), 'session-host-child-'))
  const pool = createHostAgentPool({ localMaximum: 1, desktopMaximum: 0, desktopAvailable: () => false, wait: async () => {} })
  const permit = pool.tryAcquireLocal('session')!
  const inspect = groupProcesses.readDesktopSessionGroup
  const slowInspection = vi.spyOn(groupProcesses, 'readDesktopSessionGroup').mockImplementation(async (pid) => {
    await delay(200)
    return await inspect(pid)
  })
  const executable = join(home, 'execute.ts')
  await writeFile(executable, `import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
const input = process.argv[2]!
const turn = JSON.parse(await readFile(input, 'utf8'))
await writeFile(join(dirname(input), 'result.json'), JSON.stringify({workspacePath: turn.project.path, providerSessionId: 'hogwild-native'}))
process.stdout.write(JSON.stringify({_tag:'CommandStarted',command:String(process.pid)})+'\\n')
process.stdout.write(JSON.stringify({_tag:'Message',text:process.env.HOME})+'\\n')
process.stdout.write(JSON.stringify({_tag:'TurnCompleted'})+'\\n')
`)
  let stopped = false
  let groupPid = 0
  let completion: unknown = null
  const events: unknown[] = []
  const client = createDesktopSessionClient({
    host: 'hogwild',
    home,
    executable,
    root: join(home, 'runtime'),
    signal: new AbortController().signal,
    onStopped: () => {
      stopped = true
      permit.release()
    },
    transport: transport({
      events: async (input) => {
        expect(input.host).toBe('hogwild')
        expect(pool.read().localActive).toBe(1)
        events.push(...input.events)
        const event = input.events[0]!
        if (event._tag === 'CommandStarted')
          groupPid = Number(event.command)
        return { accepted: true }
      },
      complete: async (input) => {
        completion = { ...input, stopped, remaining: await readDesktopSessionGroup(groupPid), localActive: pool.read().localActive }
        return { accepted: true }
      },
    }),
  })
  try {
    await client.run({ host: 'hogwild', sessionId: randomUUID(), turnId: randomUUID(), leaseToken: 'test', project: { id: 'pkg/test', name: 'test', path: home, kind: 'pkg' }, provider: 'codex', model: 'test', reasoningEffort: 'high', prompt: 'test', workspacePath: null, providerSessionId: null })
    expect(events).toContainEqual({ _tag: 'Message', text: process.env.HOME })
    expect(completion).toMatchObject({ host: 'hogwild', outcome: 'completed', providerSessionId: 'hogwild-native', workspacePath: home, stopped: true, remaining: [], localActive: 0 })
  }
  finally {
    slowInspection.mockRestore()
    await rm(home, { recursive: true, force: true })
  }
})
it('releases capacity after spawn failure and leaves no dead recovery handler', async () => {
  const home = await mkdtemp(join(tmpdir(), 'session-spawn-failure-'))
  let stopped = false
  let failedFence: SessionFence | null = null
  const outcomes: string[] = []
  const client = createDesktopSessionClient({
    host: 'desktop',
    home,
    root: join(home, 'runtime'),
    capacity: join(home, 'missing-capacity'),
    signal: new AbortController().signal,
    onStopped: () => { stopped = true },
    transport: transport({
      report: async () => ({ accepted: true, stops: failedFence === null ? [] : [failedFence] }),
      complete: async (input) => {
        outcomes.push(input.outcome)
        if (input.outcome === 'failed') {
          failedFence = input
          throw new Error('Completion transport is unavailable.')
        }
        return { accepted: true }
      },
    }),
  })
  try {
    await expect(client.run({ host: 'desktop', sessionId: randomUUID(), turnId: randomUUID(), leaseToken: 'test', project: { id: 'pkg/test', name: 'test', path: home, kind: 'pkg' }, provider: 'codex', model: 'test', reasoningEffort: 'high', prompt: 'test', workspacePath: null, providerSessionId: null })).rejects.toThrow('Completion transport is unavailable.')
    expect(stopped).toBe(true)
    await client.report()
    expect(outcomes).toEqual(['failed', 'stopped'])
  }
  finally { await rm(home, { recursive: true, force: true }) }
})
