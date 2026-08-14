import type { PullRequestApprovalKind } from './types.ts'

export const APPROVAL_LABELS = {
  review: 'harlan-agent-review',
} as const satisfies Record<PullRequestApprovalKind, string>

export function approvalLabels(labels: string[]): PullRequestApprovalKind[] {
  const normalized = new Set(labels.map(label => label.toLowerCase()))
  return (Object.entries(APPROVAL_LABELS) as Array<[PullRequestApprovalKind, string]>)
    .flatMap(([kind, label]) => normalized.has(label) ? [kind] : [])
}
