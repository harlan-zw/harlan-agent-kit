import { readFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { dirname, join } from 'node:path'

/** How many Agents the host memory suggests, against the configured ceiling. */
export interface AgentSlotSizing {
  /** The most Agent slots the configuration allows. */
  ceiling: number
  /** The slot count host memory suggests. Never above `ceiling`. */
  suggested: number
  /** Memory the service may spend on Agents, after the host reserve. */
  agentMemoryBytes: number
  /** Memory one Agent is assumed to need. */
  perAgentGiB: number
}

/** The live Agent slot count for each host. */
export interface AgentSlotCounts {
  hogwild: number
  desktop: number
}

export function agentSlotSizing(ceiling: number, memoryBytes: number, perAgentGiB: number): AgentSlotSizing {
  const suggested = Math.max(0, Math.min(ceiling, Math.floor(memoryBytes / (perAgentGiB * 1024 ** 3))))
  return { ceiling, suggested, agentMemoryBytes: memoryBytes, perAgentGiB }
}

/**
 * One line naming the Agent slots each host runs, and what memory suggests.
 *
 * Harlan sets the slot count from the dashboard or the tray, so the memory
 * figure is advice. A count above it still starts, and this line says so.
 */
export function agentSlotLine(slots: AgentSlotCounts, sizing: AgentSlotSizing): string {
  const available = (sizing.agentMemoryBytes / 1024 ** 3).toFixed(1)
  const capacity = `Agent slots: ${slots.hogwild} on Hogwild, ${slots.desktop} on the desktop.`
  const budget = `Host memory suggests ${sizing.suggested} at ${sizing.perAgentGiB} GiB for each Agent, from ${available} GiB available.`
  if (slots.hogwild > sizing.suggested)
    return `${capacity} ${budget} Hogwild may run out of memory.`
  return `${capacity} ${budget}`
}

/**
 * Memory the service may spend on Agents.
 *
 * Cgroup ancestors can cap the service below the host's physical memory.
 */
export async function localAgentMemoryBytes(hostReserveGiB: number): Promise<number> {
  let limit = Math.max(0, totalmem() - hostReserveGiB * 1024 ** 3)
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
