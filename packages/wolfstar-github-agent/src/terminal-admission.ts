import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export type TerminalAdmissionResult =
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
  reserve: (value: {
    requestId: string
    fingerprint: string
    key: string
    role: 'interactive'
    memoryGiB: number
    unit: string
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
    return result
  }
  return {
    completedReceipt: (value) => command(['completed', JSON.stringify(value)]),
    status: () => command(['status']),
    reserve: (value) => command(['reserve', JSON.stringify(value)]),
    bind: (value) => command(['bind', JSON.stringify(value)]),
    reconcile: (key) => command(['reconcile', 'agent', key]),
    release: (key) => command(['release', 'agent', key]),
    cancel: (value) => command(['cancel', JSON.stringify(value)]),
  }
}
