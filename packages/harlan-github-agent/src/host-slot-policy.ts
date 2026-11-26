import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseMaintenanceAuthority } from './maintenance-scope.ts'

export function effectiveMaintenanceReserve(slots: number, paused: boolean): number {
  return paused ? 0 : Math.min(1, slots)
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
