import type { AgentProviderName } from './agent-provider.ts'
import type { AgentProfile, AgentRole, RoleProfile } from './types.ts'

export const CODEX_AGENT_PROFILE = {
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
} as const satisfies AgentProfile

/** DeepSeek V4 Flash answers every role at its highest reasoning variant. */
export const OPENCODE_AGENT_PROFILE = {
  provider: 'opencode',
  authentication: 'opencode-go',
  maximumActiveAgents: 3,
  roles: {
    adversarial_review: { model: 'opencode-go/deepseek-v4-flash', reasoningEffort: 'high' },
    baseline_repair: { model: 'opencode-go/deepseek-v4-flash', reasoningEffort: 'high' },
    conflict_resolution: { model: 'opencode-go/deepseek-v4-flash', reasoningEffort: 'high' },
    issue_triage: { model: 'opencode-go/deepseek-v4-flash', reasoningEffort: 'high' },
    issue_work: { model: 'opencode-go/deepseek-v4-flash', reasoningEffort: 'high' },
    review_fix: { model: 'opencode-go/deepseek-v4-flash', reasoningEffort: 'high' },
  },
} as const satisfies AgentProfile

const profiles: Record<AgentProviderName, AgentProfile> = {
  codex: CODEX_AGENT_PROFILE,
  opencode: OPENCODE_AGENT_PROFILE,
}

export function agentProfile(provider: AgentProviderName): AgentProfile {
  return profiles[provider]
}

export function roleProfile(profile: AgentProfile, role: AgentRole): RoleProfile {
  return profile.roles[role]
}
