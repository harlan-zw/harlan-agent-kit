import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseHostTerminalCapacity } from './terminal-capacity.ts'

export type TerminalAdmissionDecision =
  | { _tag: 'Allowed' }
  | { _tag: 'AtCapacity'; reason: string; memoryGiB: number; reservedGiB: number }
  | { _tag: 'Unavailable'; reason: string }
export interface TerminalAdmissionCapacity {
  _tag: 'Capacity'
  memoryGiB: number
  reservedGiB: number
  agentSlots: number
  agentSlotsUsed: number
  maintenanceReserve: number
  forcedGiB: number
  sessionMemoryGiB: number
  memory:
    | { _tag: 'Physical'; availableGiB: number; totalGiB: number }
    | { _tag: 'Available'; availableGiB: number }
    | { _tag: 'Unknown'; reason: string }
  manualPolicy:
    | { _tag: 'Disabled' }
    | { _tag: 'Enabled'; memoryGiB: number; agentSlotsMax: number; physicalReserveGiB: number }
  regular: TerminalAdmissionDecision
  manual: TerminalAdmissionDecision
}

const execute = promisify(execFile)
export type TerminalAdmissionResult =
  | TerminalAdmissionCapacity
  | {
      _tag: 'Status'
      memoryGiB: number
      reservedGiB: number
      policy: { agentSlots: number; maintenanceReserve: number }
      reservations: Record<string, { kind: 'agent' | 'actions'; role?: 'interactive' | 'maintenance' }>
    }
  | {
      _tag: 'Admitted'
      reservationId: string
      disposition: 'Created' | 'Existing'
      unit: string
      hostId: string
      bootId: string
    }
  | {
      _tag: 'Alive'
      reservationId: string
      scope: { unit: string; invocationId: string; controlGroup: string } | null
    }
  | {
      _tag: 'Bound'
      reservationId: string
      scope: { unit: string; invocationId: string; controlGroup: string }
    }
  | { _tag: 'Empty' }
  | { _tag: 'Unknown'; reason?: string }
  | { _tag: 'AtCapacity'; reason: string }
  | { _tag: 'Unavailable'; reason: string }
  | { _tag: 'Conflict' | 'Missing' }
  | { _tag: 'Completed' }
export interface TerminalAdmission {
  completedReceipt: (value: {
    requestId: string
    fingerprint: string
    key: string
    reservationId: string
    unit: string
  }) => Promise<TerminalAdmissionResult>
  status: () => Promise<TerminalAdmissionResult>
  capacity: () => Promise<TerminalAdmissionResult>
  reserve: (value: {
    requestId: string
    fingerprint: string
    key: string
    role: 'interactive'
    memoryGiB: number
    unit: string
    admission: 'Regular' | 'ManualOverride'
  }) => Promise<TerminalAdmissionResult>
  bind: (value: {
    key: string
    reservationId: string
    unit: string
    invocationId: string
  }) => Promise<TerminalAdmissionResult>
  reconcile: (key: string) => Promise<TerminalAdmissionResult>
  release: (key: string) => Promise<TerminalAdmissionResult>
  cancel: (value: { key: string; reservationId: string }) => Promise<TerminalAdmissionResult>
}
export function createTerminalAdmissionCli(path: string): TerminalAdmission {
  async function command(args: string[]) {
    const { stdout } = await execute(path, args, {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    }).catch((cause: Error & { stdout?: string; code?: number | string }) => {
      if (typeof cause.code === 'number' && [1, 69, 73, 75].includes(cause.code) && cause.stdout) {
        return { stdout: cause.stdout }
      }
      throw cause
    })
    const result = JSON.parse(stdout) as TerminalAdmissionResult
    if (
      ![
        'Status',
        'Capacity',
        'Admitted',
        'Alive',
        'Bound',
        'Empty',
        'Unknown',
        'AtCapacity',
        'Unavailable',
        'Conflict',
        'Missing',
        'Completed',
      ].includes(result._tag)
    ) {
      throw new Error('Invalid host admission response')
    }
    if (result._tag === 'Capacity' && parseHostTerminalCapacity(result)._tag === 'Err')
      throw new Error('Invalid host admission capacity')
    return result
  }
  return {
    completedReceipt: (value) => command(['completed', JSON.stringify(value)]),
    status: () => command(['status']),
    capacity: () => command(['capacity', '8']),
    reserve: ({ admission, ...value }) =>
      command([admission === 'ManualOverride' ? 'reserve-manual' : 'reserve', JSON.stringify(value)]),
    bind: (value) => command(['bind', JSON.stringify(value)]),
    reconcile: (key) => command(['reconcile', 'agent', key]),
    release: (key) => command(['release', 'agent', key]),
    cancel: (value) => command(['cancel', JSON.stringify(value)]),
  }
}
