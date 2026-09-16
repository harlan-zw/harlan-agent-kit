import { readFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { dirname, join } from 'node:path'

/** How many Agents the host memory grants, against what the configuration asked for. */
export interface AgentSlotSizing {
  /** The slot count the configuration file asked for. */
  configured: number
  /** The slot count the host memory allows. Never above `configured`. */
  granted: number
  /** Memory the service may spend on Agents, after the host reserve. */
  agentMemoryBytes: number
  /** Memory one Agent is assumed to need. */
  perAgentGiB: number
}

export function agentSlotSizing(configured: number, memoryBytes: number, perAgentGiB: number): AgentSlotSizing {
  const granted = Math.max(0, Math.min(configured, Math.floor(memoryBytes / (perAgentGiB * 1024 ** 3))))
  return { configured, granted, agentMemoryBytes: memoryBytes, perAgentGiB }
}

/**
 * One line naming the Agent capacity the host really grants.
 *
 * The memory clamp used to be silent. A configuration asking for four Agents
 * ran two, and nothing said so. Every start now reports the granted count.
 */
export function agentSlotSizingLine(sizing: AgentSlotSizing): string {
  const available = (sizing.agentMemoryBytes / 1024 ** 3).toFixed(1)
  const capacity = `Agent slots: ${sizing.granted} of ${sizing.configured} requested.`
  const budget = `Host memory grants ${available} GiB at ${sizing.perAgentGiB} GiB for each Agent.`
  if (sizing.granted >= sizing.configured)
    return `${capacity} ${budget}`
  return `${capacity} ${budget} To grant more, lower agent.memory_per_agent_gib or agent.host_reserve_gib.`
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
