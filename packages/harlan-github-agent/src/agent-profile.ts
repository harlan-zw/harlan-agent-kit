import type { AgentProvider, AgentProviderName } from './agent-provider.ts'
import type { Result } from './result.ts'
import type { AgentModel, AgentProfile, AgentRole, AgentSelection, CodexReasoningEffort, PinnedAgentSelection, RoleProfile } from './types.ts'
import { err, ok } from './result.ts'

export const CODEX_AGENT_PROFILE = {
  provider: 'codex',
  authentication: 'chatgpt',
  maximumActiveAgents: 4,
  roles: {
    adversarial_review: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    baseline_repair: { model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
    conflict_resolution: { model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
    issue_triage: { model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
    issue_work: { model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
    review_fix: { model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
  },
} as const satisfies AgentProfile

/** DeepSeek V4 Flash answers every role at its highest reasoning effort. */
export const OPENCODE_AGENT_PROFILE = {
  provider: 'opencode',
  authentication: 'opencode-go',
  maximumActiveAgents: 4,
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

export const AGENT_PROVIDER_NAMES = ['codex', 'opencode'] as const satisfies readonly AgentProviderName[]

export const AGENT_ROLES = [
  'adversarial_review',
  'baseline_repair',
  'conflict_resolution',
  'issue_triage',
  'issue_work',
  'review_fix',
] as const satisfies readonly AgentRole[]

/** Every model an Agent provider answers with, in the order the controls list them. */
export const AGENT_MODELS = {
  codex: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  opencode: [
    'opencode/big-pickle',
    'opencode/deepseek-v4-flash-free',
    'opencode/hy3-free',
    'opencode/laguna-s-2.1-free',
    'opencode/mimo-v2.5-free',
    'opencode/nemotron-3-ultra-free',
    'opencode/nemotron-3.5-lightning-free',
    'opencode-go/deepseek-v4-flash',
    'opencode-go/deepseek-v4-pro',
    'opencode-go/glm-5.1',
    'opencode-go/glm-5.2',
    'opencode-go/glm-5.3',
    'opencode-go/glm-5.3-flash',
    'opencode-go/gpt-5.6-luna',
    'opencode-go/grok-4.5',
    'opencode-go/hy3',
    'opencode-go/kimi-k2.6',
    'opencode-go/kimi-k2.7-code',
    'opencode-go/kimi-k3',
    'opencode-go/mimo-v2.5',
    'opencode-go/mimo-v2.5-pro',
    'opencode-go/minimax-m2.7',
    'opencode-go/minimax-m3',
    'opencode-go/qwen3.6-plus',
    'opencode-go/qwen3.7-max',
    'opencode-go/qwen3.7-plus',
  ],
} as const satisfies Record<AgentProviderName, readonly AgentModel[]>

export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly CodexReasoningEffort[]

export type { AgentSelection, PinnedAgentSelection } from './types.ts'

/** The profile and the provider runtime that answers it. They never disagree. */
export interface AgentRuntime {
  profile: AgentProfile
  provider: AgentProvider
}

/** Reads the Agent runtime that answers the next agent turn. */
export type AgentRuntimeSource = () => AgentRuntime

export function agentProfile(provider: AgentProviderName): AgentProfile {
  return profiles[provider]
}

export function roleProfile(profile: AgentProfile, role: AgentRole): RoleProfile {
  return profile.roles[role]
}

/** The pinned selection that keeps every default of one Agent provider. */
export function providerAgentSelection(provider: AgentProviderName): PinnedAgentSelection {
  return { provider, model: null, reasoningEffort: null }
}

/**
 * Reads the Agent provider, model, and reasoning effort in force right now.
 *
 * If the Agent selection follows the configuration, the configuration decides.
 * The service reads its configuration file at every start, so a cleared
 * selection follows the file again after a restart.
 */
export function resolveAgentSelection(selection: AgentSelection, configured: PinnedAgentSelection): PinnedAgentSelection {
  return selection._tag === 'Pinned' ? selection : configured
}

/**
 * Parses one untrusted Agent selection.
 *
 * A model belongs to exactly one Agent provider, so a model from the other
 * provider is rejected here and can never reach a turn.
 */
export function parseAgentSelection(value: unknown): Result<AgentSelection, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return err('Send an Agent selection to apply.')
  const body = value as Record<string, unknown>
  if (body._tag === 'FollowsConfiguration')
    return ok({ _tag: 'FollowsConfiguration' })
  if (body._tag !== 'Pinned')
    return err('Pin an Agent provider, or follow the configuration.')
  const provider = AGENT_PROVIDER_NAMES.find(candidate => candidate === body.provider)
  if (provider === undefined)
    return err('Select codex or opencode as the Agent provider.')

  const models: readonly AgentModel[] = AGENT_MODELS[provider]
  const requestedModel = body.model ?? null
  const model = requestedModel === null ? null : models.find(candidate => candidate === requestedModel)
  if (model === undefined)
    return err(`The Agent provider ${provider} does not offer that model.`)

  const requestedEffort = body.reasoningEffort ?? null
  const reasoningEffort = requestedEffort === null ? null : REASONING_EFFORTS.find(candidate => candidate === requestedEffort)
  if (reasoningEffort === undefined)
    return err(`Select one reasoning effort: ${REASONING_EFFORTS.slice(0, -1).join(', ')}, or ${REASONING_EFFORTS.at(-1)}.`)

  return ok({ _tag: 'Pinned', provider, model, reasoningEffort })
}

function roleWithSelection(role: RoleProfile, selection: PinnedAgentSelection): RoleProfile {
  const model = selection.model ?? role.model
  const reasoningEffort = selection.reasoningEffort ?? role.reasoningEffort
  return reasoningEffort === undefined ? { model } : { model, reasoningEffort }
}

/**
 * Builds the profile one Agent selection describes.
 *
 * The service sizes its agent permits when it starts, so agent capacity comes
 * from the caller and never from the selected provider's own profile.
 */
export function resolveAgentProfile(selection: PinnedAgentSelection, maximumActiveAgents: number): AgentProfile {
  const base = agentProfile(selection.provider)
  const roles = Object.fromEntries(
    AGENT_ROLES.map(role => [role, roleWithSelection(base.roles[role], selection)]),
  ) as Record<AgentRole, RoleProfile>
  return { ...base, maximumActiveAgents, roles }
}

export interface AgentRuntimeSourceOptions {
  /** The Agent provider the configuration file names, read at every start. */
  configuredProvider: AgentProviderName
  maximumActiveAgents: number
  providers: Record<AgentProviderName, AgentProvider>
  selection: () => AgentSelection
}

/**
 * Pairs the current Agent selection with the runtime that answers it.
 *
 * Every provider runtime is built once, so a switch costs one journal read and
 * never restarts the service.
 */
export function createAgentRuntimeSource(options: AgentRuntimeSourceOptions): AgentRuntimeSource {
  const configured = providerAgentSelection(options.configuredProvider)
  return () => {
    const selection = resolveAgentSelection(options.selection(), configured)
    return {
      profile: resolveAgentProfile(selection, options.maximumActiveAgents),
      provider: options.providers[selection.provider],
    }
  }
}
