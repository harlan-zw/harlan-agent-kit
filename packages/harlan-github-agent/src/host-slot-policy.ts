import type { HostSharedMemory } from './host-capacity.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseMaintenanceAuthority } from './maintenance-scope.ts'

export function effectiveMaintenanceReserve(slots: number, paused: boolean): number {
  return paused ? 0 : Math.min(1, slots)
}

/** Aggregate shared memory and reservation counts from host-capacity status. Root diagnostics stay private. */
export function parseHostSharedMemory(input: unknown): HostSharedMemory | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return undefined
  const value = input as Record<string, unknown>
  if (value._tag !== 'Status'
    || !Number.isSafeInteger(value.memoryGiB) || Number(value.memoryGiB) < 1 || Number(value.memoryGiB) > 4096
    || !Number.isSafeInteger(value.reservedGiB) || Number(value.reservedGiB) < 0 || Number(value.reservedGiB) > 4096
    || typeof value.policy !== 'object' || value.policy === null || Array.isArray(value.policy)) {
    return undefined
  }
  const policy = value.policy as Record<string, unknown>
  if (!Number.isSafeInteger(policy.maintenanceReserve) || Number(policy.maintenanceReserve) < 0)
    return undefined
  const memoryGiB = Number(value.memoryGiB)
  const actionsMemoryGiB = value.actionsMemoryGiB === undefined
    ? memoryGiB
    : Number.isSafeInteger(value.actionsMemoryGiB) && Number(value.actionsMemoryGiB) >= memoryGiB && Number(value.actionsMemoryGiB) <= 4096
      ? Number(value.actionsMemoryGiB)
      : undefined
  if (actionsMemoryGiB === undefined)
    return undefined
  let actions = 0
  let agents = 0
  if (typeof value.reservations === 'object' && value.reservations !== null && !Array.isArray(value.reservations)) {
    for (const entry of Object.values(value.reservations as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null)
        continue
      const kind = (entry as Record<string, unknown>).kind
      if (kind === 'actions')
        actions += 1
      else if (kind === 'agent')
        agents += 1
    }
  }
  return {
    memoryGiB,
    actionsMemoryGiB,
    reservedGiB: Number(value.reservedGiB),
    maintenanceReserve: Number(policy.maintenanceReserve),
    actions,
    agents,
  }
}

export async function readHostSharedMemory(command: string): Promise<HostSharedMemory | undefined> {
  const result = await promisify(execFile)(command, ['status'], { timeout: 5000, maxBuffer: 1024 * 1024 })
  const value: unknown = JSON.parse(result.stdout)
  return parseHostSharedMemory(value)
}

export async function setHostSlotPolicy(command: string, slots: number, reserve = Math.min(1, slots)): Promise<void> {
  if (!Number.isSafeInteger(slots) || slots < 0 || slots > 256)
    throw new Error('Set a valid Agent slot count.')
  if (!Number.isSafeInteger(reserve) || (reserve !== 0 && reserve !== Math.min(1, slots)))
    throw new Error('Set a valid maintenance Reserve count.')
  const result = await promisify(execFile)(command, ['policy', String(slots), String(reserve)], { timeout: 10000, maxBuffer: 1024 * 1024 })
  const value: unknown = JSON.parse(result.stdout)
  parseMaintenanceAuthority(value)
  const state = value as { policy: { agentSlots: number, maintenanceReserve: number } }
  if (state.policy.agentSlots !== slots || state.policy.maintenanceReserve !== reserve)
    throw new Error('The host refused the Agent slot policy.')
}
