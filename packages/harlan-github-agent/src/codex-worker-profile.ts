import type { CodexRoleProfile, CodexWorkerProfile, WorkerRole } from './types.ts'

export const CODEX_WORKER_PROFILE = {
  provider: 'codex',
  authentication: 'chatgpt',
  maximumActiveAgents: 3,
  roles: {
    adversarial_review: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    baseline_repair: { model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
    conflict_resolution: { model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
    issue_triage: { model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
    issue_work: { model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
    review_fix: { model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
  },
} as const satisfies CodexWorkerProfile

export function codexWorkerProfile(role: WorkerRole): CodexRoleProfile {
  return CODEX_WORKER_PROFILE.roles[role]
}
