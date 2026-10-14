import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createMaintenanceCheckCommand, createMaintenanceScopeProvider } from '../src/maintenance-scope.ts'
import { runRepairRecoveryChecks } from '../src/worktree.ts'

function child() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams
}
const request = {
  model: 'test',
  outputSchema: {},
  prompt: 'test',
  sessionId: null,
  signal: new AbortController().signal,
  workspace: '/tmp/test',
  taskId: 'task-1',
}
const status = {
  _tag: 'Status',
  hostId: 'host',
  bootId: 'boot',
  policy: { agentSlots: 2, maintenanceReserve: 1 },
  memoryGiB: 8,
  reservedGiB: 0,
  reservations: {},
}

describe('maintenance scope provider', () => {
  it('refuses an old authority before any worker starts', async () => {
    let starts = 0
    const provider = createMaintenanceScopeProvider({
      name: 'codex',
      capacityCommand: '/capacity',
      memoryGiB: 3,
      status: async () => ({ memoryGiB: 8 }),
      spawn: () => {
        starts++
        return child()
      },
    })
    const events = []
    for await (const event of provider.runTurn(request)) events.push(event)
    expect(starts).toBe(0)
    expect(events).toEqual([expect.objectContaining({ _tag: 'Failed', cause: 'resource-limit' })])
  })
  it('starts one admitted worker and preserves provider events', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const worker = child()
    const provider = createMaintenanceScopeProvider({
      name: 'opencode',
      capacityCommand: '/capacity',
      memoryGiB: 3,
      status: async () => status,
      spawn: (command, args) => {
        calls.push({ command, args })
        setImmediate(() => {
          ;(worker.stdout as PassThrough).end('{"_tag":"Message","text":"done"}\n{"_tag":"TurnCompleted"}\n')
          worker.emit('close', 0)
        })
        return worker
      },
    })
    const events = []
    for await (const event of provider.runTurn(request)) events.push(event)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('/capacity')
    expect(calls[0]?.args.slice(0, 3)).toEqual(['run', expect.stringMatching(/^maintenance:/), '3'])
    expect(events).toEqual([{ _tag: 'Message', text: 'done' }, { _tag: 'TurnCompleted' }])
  })
  it('waits for admission without failing or completing the refused turn', async () => {
    let starts = 0
    let waits = 0
    const provider = createMaintenanceScopeProvider({
      name: 'codex',
      capacityCommand: '/capacity',
      memoryGiB: 3,
      status: async () => status,
      wait: async () => {
        waits++
      },
      spawn: () => {
        const worker = child()
        const attempt = ++starts
        setImmediate(() => {
          ;(worker.stdout as PassThrough).end(
            attempt === 1
              ? '{"_tag":"AtCapacity","reason":"Memory","memoryGiB":8,"reservedGiB":8}\n'
              : '{"_tag":"Message","text":"done"}\n{"_tag":"TurnCompleted"}\n',
          )
          worker.emit('close', attempt === 1 ? 75 : 0)
        })
        return worker
      },
    })
    const events = []
    for await (const event of provider.runTurn(request)) events.push(event)
    expect(events).toEqual([{ _tag: 'Message', text: 'done' }, { _tag: 'TurnCompleted' }])
    expect(starts).toBe(2)
    expect(waits).toBe(1)
  })
  it('cancels a waiting admission without starting another worker', async () => {
    const controller = new AbortController()
    let starts = 0
    const provider = createMaintenanceScopeProvider({
      name: 'codex',
      capacityCommand: '/capacity',
      memoryGiB: 3,
      status: async () => status,
      wait: async () => {
        controller.abort()
      },
      spawn: () => {
        starts++
        const worker = child()
        setImmediate(() => {
          ;(worker.stdout as PassThrough).end('{"_tag":"AtCapacity","reason":"Slots","memoryGiB":8,"reservedGiB":8}\n')
          worker.emit('close', 75)
        })
        return worker
      },
    })
    const events = []
    for await (const event of provider.runTurn({ ...request, signal: controller.signal })) events.push(event)
    expect(events).toEqual([expect.objectContaining({ _tag: 'Failed', cause: 'host-cancelled' })])
    expect(starts).toBe(1)
  })
  it.each([
    ['provider events', '{"_tag":"Message","text":"started"}\n', 75],
    ['missing refusal', '', 75],
    ['invalid refusal', '{"_tag":"AtCapacity","reason":"anything"}\n', 75],
    ['wrong exit code', '{"_tag":"AtCapacity","reason":"Memory","memoryGiB":8,"reservedGiB":8}\n', 0],
    [
      'mixed response',
      '{"_tag":"Message","text":"started"}\n{"_tag":"AtCapacity","reason":"Memory","memoryGiB":8,"reservedGiB":8}\n',
      75,
    ],
  ])('does not retry %s', async (_name, output, code) => {
    let waits = 0
    const worker = child()
    const provider = createMaintenanceScopeProvider({
      name: 'codex',
      capacityCommand: '/capacity',
      memoryGiB: 3,
      status: async () => status,
      wait: async () => {
        waits++
      },
      spawn: () => {
        setImmediate(() => {
          ;(worker.stdout as PassThrough).end(String(output))
          worker.emit('close', Number(code))
        })
        return worker
      },
    })
    const events = []
    for await (const event of provider.runTurn(request)) events.push(event)
    expect(events.at(-1)).toEqual(expect.objectContaining({ _tag: 'Failed', cause: 'resource-limit' }))
    expect(waits).toBe(0)
  })
  it('keeps Review callbacks bound to the captured worker fence', async () => {
    const worker = child()
    const owners: unknown[] = []
    const reservation = {
      taskId: 'task-1',
      headSha: 'a'.repeat(40),
      sourceSha256: 'b'.repeat(64),
      startedAt: '2026-10-12T00:00:00.000Z',
    }
    const callback = {
      _tag: 'ReviewProofCallback',
      id: '00000000-0000-4000-8000-000000000000',
      action: 'reserve',
      input: reservation,
    }
    let answer = ''
    worker.stdin.on('data', (chunk) => {
      answer += String(chunk)
      ;(worker.stdout as PassThrough).end('{"_tag":"TurnCompleted"}\n')
      worker.emit('close', 0)
    })
    const provider = createMaintenanceScopeProvider({
      name: 'codex',
      capacityCommand: '/capacity',
      memoryGiB: 3,
      status: async () => status,
      reviewProofAuthority: (owner) => {
        owners.push(owner)
        return { reserve: async () => ({ _tag: 'Reserved', reservationId: 'proof-1' }), finish: async () => {} }
      },
      spawn: () => {
        setImmediate(() => (worker.stdout as PassThrough).write(`${JSON.stringify(callback)}\n`))
        return worker
      },
    })
    const events = []
    for await (const event of provider.runTurn({
      ...request,
      toolPolicy: {
        _tag: 'Review',
        baseSha: 'c'.repeat(40),
        headSha: reservation.headSha,
        workerId: 'worker-1',
        fence: 7,
      },
    }))
      events.push(event)
    expect(events).toEqual([{ _tag: 'TurnCompleted' }])
    expect(owners).toEqual([{ taskId: 'task-1', headSha: reservation.headSha, workerId: 'worker-1', fence: 7 }])
    expect(JSON.parse(answer)).toEqual({ id: callback.id, result: { _tag: 'Reserved', reservationId: 'proof-1' } })
  })
})

describe('maintenance recovery admission', () => {
  it('waits for capacity before running a recovery check', async () => {
    let starts = 0
    const run = createMaintenanceCheckCommand({
      capacityCommand: '/capacity',
      memoryGiB: 3,
      status: async () => status,
      wait: async () => {},
      spawn: () => {
        const worker = child()
        const attempt = ++starts
        setImmediate(() => {
          ;(worker.stdout as PassThrough).end(
            attempt === 1
              ? '{"_tag":"AtCapacity","reason":"MemoryPressure","memoryGiB":8,"reservedGiB":8}\n'
              : '{"_tag":"CheckResult","exitCode":1,"stdout":"assertion failed","stderr":""}\n',
          )
          worker.emit('close', attempt === 1 ? 75 : 0)
        })
        return worker
      },
    })
    expect(await run({ workspace: '/tmp/test', command: 'pnpm', args: ['test'], signal: request.signal })).toEqual({
      exitCode: 1,
      stdout: 'assertion failed',
      stderr: '',
    })
    expect(starts).toBe(2)
  })
  it('requires explicit admission for recovery instead of launching a direct sandbox', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maintenance-recovery-'))
    try {
      await writeFile(join(root, 'package.json'), '{"scripts":{"test":"vitest"}}')
      await writeFile(join(root, 'selected.test.ts'), 'export {}')
      await expect(runRepairRecoveryChecks(root, ['selected.test.ts'], request.signal)).rejects.toThrow(
        'Recovery commands require shared host admission.',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('returns the admitted sandbox exit code without changing check failures', async () => {
    const worker = child()
    const run = createMaintenanceCheckCommand({
      capacityCommand: '/capacity',
      memoryGiB: 3,
      status: async () => status,
      spawn: () => {
        setImmediate(() => {
          ;(worker.stdout as PassThrough).end(
            '{"_tag":"CheckResult","exitCode":1,"stdout":"assertion failed","stderr":""}\n',
          )
          worker.emit('close', 0)
        })
        return worker
      },
    })
    expect(await run({ workspace: '/tmp/test', command: 'pnpm', args: ['test'], signal: request.signal })).toEqual({
      exitCode: 1,
      stdout: 'assertion failed',
      stderr: '',
    })
  })
  it('never runs a recovery command without the authority', async () => {
    let starts = 0
    const run = createMaintenanceCheckCommand({
      capacityCommand: '/capacity',
      memoryGiB: 3,
      status: async () => {
        throw new Error('authority offline')
      },
      spawn: () => {
        starts++
        return child()
      },
    })
    await expect(
      run({ workspace: '/tmp/test', command: 'pnpm', args: ['test'], signal: request.signal }),
    ).rejects.toThrow('authority offline')
    expect(starts).toBe(0)
  })
  it('cancels only the owned wrapper and awaits its normal exit', async () => {
    const controller = new AbortController()
    const worker = child()
    const signals: string[] = []
    worker.kill = (signal) => {
      signals.push(String(signal))
      ;(worker.stdout as PassThrough).end()
      worker.emit('close', 143)
      return true
    }
    const provider = createMaintenanceScopeProvider({
      name: 'codex',
      capacityCommand: '/capacity',
      memoryGiB: 3,
      status: async () => status,
      spawn: () => {
        setImmediate(() => controller.abort())
        return worker
      },
    })
    const events = []
    for await (const event of provider.runTurn({ ...request, signal: controller.signal })) events.push(event)
    expect(signals).toEqual(['SIGTERM'])
    expect(events).toEqual([expect.objectContaining({ _tag: 'Failed', cause: 'host-cancelled' })])
  })
})
