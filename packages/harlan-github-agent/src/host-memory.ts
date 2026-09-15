import { readFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { dirname, join } from 'node:path'

export function agentSlotsForMemory(configured: number, memoryBytes: number, perAgentGiB: number): number {
  return Math.max(0, Math.min(configured, Math.floor(memoryBytes / (perAgentGiB * 1024 ** 3))))
}

/** Cgroup ancestors can cap the service below the host's physical memory. */
export async function localAgentMemoryBytes(): Promise<number> {
  let limit = Math.max(0, totalmem() - 8 * 1024 ** 3)
  const groups = await readFile('/proc/self/cgroup', 'utf8')
  const group = groups.split('\n').find(line => line.startsWith('0::'))?.slice(3)
  if (group === undefined)
    throw new Error('Agent memory accounting requires cgroup v2.')
  let directory = join('/sys/fs/cgroup', group)
  while (directory.startsWith('/sys/fs/cgroup')) {
    const value = (await readFile(join(directory, 'memory.max'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        return 'max'
      throw error
    })).trim()
    if (value !== 'max') {
      const bytes = Number(value)
      if (!Number.isSafeInteger(bytes) || bytes < 0)
        throw new Error('Agent memory limit is invalid.')
      limit = Math.min(limit, bytes)
    }
    if (directory === '/sys/fs/cgroup')
      break
    directory = dirname(directory)
  }
  return limit
}
