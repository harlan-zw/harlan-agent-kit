import type { Result } from './result.ts'
import { err, ok } from './result.ts'

export interface IncidentResolutionRequest {
  incidentId: string
  lastSeenAt: string
  evidence: string
}

export interface IncidentResolutionReceipt {
  _tag: 'Resolved' | 'AlreadyResolved'
}
export interface IncidentResolutionError {
  _tag: 'NotFound' | 'Changed' | 'TaskActive'
}

export function parseIncidentResolutionRequest(value: unknown): Result<IncidentResolutionRequest, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return err('Set an incident ID, lastSeenAt, and evidence.')
  const input = value as Record<string, unknown>
  if (
    typeof input.incidentId !== 'string' ||
    !/^[a-f\d]{64}$/.test(input.incidentId) ||
    typeof input.lastSeenAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.lastSeenAt) ||
    !Number.isFinite(Date.parse(input.lastSeenAt)) ||
    typeof input.evidence !== 'string' ||
    input.evidence.trim().length === 0 ||
    input.evidence.length > 4000
  ) {
    return err('Set an exact incident ID, UTC lastSeenAt, and evidence under 4001 characters.')
  }
  return ok({ incidentId: input.incidentId, lastSeenAt: input.lastSeenAt, evidence: input.evidence })
}

export function parseIncidentResolutionReceipt(value: unknown): Result<IncidentResolutionReceipt, string> {
  if (
    typeof value === 'object' &&
    value !== null &&
    '_tag' in value &&
    (value._tag === 'Resolved' || value._tag === 'AlreadyResolved')
  ) {
    return ok({ _tag: value._tag })
  }
  return err('The Service returned an invalid incident resolution.')
}
