import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execute = promisify(execFile)
interface WorkerMemoryDependencies {
  execute: (args: string[]) => Promise<{ stdout: string }>
  readEvents: (path: string) => Promise<string>
  newId: () => string
}

export function createWorkerMemoryLimiter(dependencies: WorkerMemoryDependencies) {
  const reservations = new Map<string, Promise<{ references: number, memoryGiB: number, events: string, unit: string }>>()

  /** Keep every process for one Task under one memory budget, outside the controller. */
  return async function workerMemoryCommand(input: { binary: string, args: string[], memoryGiB: number, taskId?: string }) {
    if (!Number.isFinite(input.memoryGiB) || input.memoryGiB <= 0)
      throw new Error('The Agent memory budget must be positive.')
    const identity = input.taskId ?? dependencies.newId()
    if (identity.length === 0 || identity.length > 4096)
      throw new Error('The Agent Task identity is invalid.')
    const key = createHash('sha256').update(identity).digest('hex')
    let pending = reservations.get(key)
    if (pending === undefined) {
      const unit = `hrlagent${key}${dependencies.newId().replaceAll('-', '')}.slice`
      pending = (async () => {
        await dependencies.execute(['--user', 'set-property', '--runtime', unit, `MemoryMax=${Math.floor(input.memoryGiB * 1024 ** 3)}`, 'MemorySwapMax=0'])
        await dependencies.execute(['--user', 'start', unit])
        const { stdout } = await dependencies.execute(['--user', 'show', unit, '--property=ControlGroup', '--value'])
        if (!stdout.trim().startsWith('/user.slice/'))
          throw new Error('The Agent Task memory group is missing.')
        return { references: 0, memoryGiB: input.memoryGiB, events: `/sys/fs/cgroup${stdout.trim()}/memory.events`, unit }
      })().catch(async (error: unknown) => {
        await dependencies.execute(['--user', 'stop', unit])
        await dependencies.execute(['--user', 'revert', unit])
        throw error
      })
      reservations.set(key, pending)
    }
    const reservation = await pending.catch((error: unknown) => {
      if (reservations.get(key) === pending)
        reservations.delete(key)
      throw error
    })
    if (reservation.memoryGiB !== input.memoryGiB)
      throw new Error('The Agent Task memory budget changed during its turn.')
    reservation.references += 1
    let releasePromise: Promise<void> | undefined
    let exceeded = false
    const memoryExceeded = async (): Promise<boolean> => {
      if (exceeded)
        return true
      const value = await dependencies.readEvents(reservation.events).catch((error: NodeJS.ErrnoException) => {
      // The kernel may remove the empty group before diagnostics read it.
        if (error.code === 'ENOENT' || error.code === 'ENODEV')
          return ''
        throw error
      })
      exceeded = /^oom_kill\s+[1-9]\d*$/m.test(value)
      return exceeded
    }
    return {
      binary: '/usr/bin/systemd-run',
      args: ['--user', '--scope', '--quiet', `--slice=${reservation.unit}`, `--unit=harlan-worker-${dependencies.newId()}`, '--property=OOMPolicy=kill', input.binary, ...input.args],
      memoryExceeded,
      release(): Promise<void> {
        releasePromise ??= (async () => {
          try {
            await memoryExceeded()
          }
          finally {
            reservation.references -= 1
            if (reservation.references === 0) {
              if (reservations.get(key) === pending)
                reservations.delete(key)
              await dependencies.execute(['--user', 'stop', reservation.unit])
              await dependencies.execute(['--user', 'revert', reservation.unit])
            }
          }
        })()
        return releasePromise
      },
    }
  }
}

export const workerMemoryCommand = createWorkerMemoryLimiter({
  execute: args => execute('systemctl', args, { timeout: 10_000 }),
  readEvents: path => readFile(path, 'utf8'),
  newId: randomUUID,
})
