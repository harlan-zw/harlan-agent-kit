import type { CodexReasoningEffort, WorkersAiAgentModel } from './types.ts'
import type { Result } from './result.ts'
import { err, ok } from './result.ts'

/**
 * Cloudflare Workers AI, reached through opencode's own provider.
 *
 * opencode already speaks to the Workers AI OpenAI compatible endpoint, so a
 * Workers AI model is one more opencode model and needs no provider of its
 * own. It publishes no quota window, so capacity reads it as unpublished and
 * the per-model circuit is what stops a failing one.
 *
 * The sandbox clears the environment, so opencode cannot read
 * `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_KEY`. Both live in `opencode.json`
 * instead, under `providers.cloudflare-workers-ai.settings` as `apiKey` and
 * `baseURL`, beside the GLM Coding Plan key. Worker provisioning and Review
 * homes copy them from there, so no Agent tool sees them in the environment.
 */
export const WORKERS_AI_PROVIDER = 'cloudflare-workers-ai'

/**
 * The reasoning variants opencode exposes for each model, read from
 * `opencode models cloudflare-workers-ai --verbose`. Only tool calling models
 * with a long context are listed, because a turn edits files through tools.
 */
export const WORKERS_AI_VARIANTS = {
  'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code': [],
  'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6': ['none', 'high'],
  'cloudflare-workers-ai/@cf/zai-org/glm-5.3': ['low', 'high', 'max'],
  'cloudflare-workers-ai/@cf/zai-org/glm-5.3-flash': ['low', 'high', 'max'],
  'cloudflare-workers-ai/@cf/zai-org/glm-5.2': ['none', 'high', 'max'],
  'cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813': ['none', 'low', 'high', 'max'],
  'cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731': ['none', 'low', 'high', 'max'],
  'cloudflare-workers-ai/@cf/qwen/qwen3.8-27b': ['low', 'medium', 'xhigh'],
  'cloudflare-workers-ai/@cf/openai/gpt-oss-120b': ['low', 'medium', 'high'],
} as const satisfies Record<WorkersAiAgentModel, readonly CodexReasoningEffort[]>

/** The models in the order the Agent selection lists them. */
export const WORKERS_AI_MODELS = [
  'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code',
  'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6',
  'cloudflare-workers-ai/@cf/zai-org/glm-5.3',
  'cloudflare-workers-ai/@cf/zai-org/glm-5.3-flash',
  'cloudflare-workers-ai/@cf/zai-org/glm-5.2',
  'cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813',
  'cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731',
  'cloudflare-workers-ai/@cf/qwen/qwen3.8-27b',
  'cloudflare-workers-ai/@cf/openai/gpt-oss-120b',
] as const satisfies readonly WorkersAiAgentModel[]

const EFFORT_ORDER: readonly CodexReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

export function isWorkersAiModel(model: string): model is WorkersAiAgentModel {
  return Object.hasOwn(WORKERS_AI_VARIANTS, model)
}

/**
 * The variant one Workers AI model can run at for the effort a role asked for.
 *
 * Each model exposes its own set, and opencode fails the turn with `Variant
 * unavailable` for one the model does not list. The closest one at or below the request wins, then the
 * lowest the model has. A model with no variants runs without one.
 */
export function workersAiVariant(
  model: WorkersAiAgentModel,
  effort: string | undefined,
): CodexReasoningEffort | undefined {
  const supported: readonly CodexReasoningEffort[] = WORKERS_AI_VARIANTS[model]
  const requested = EFFORT_ORDER.indexOf(effort as CodexReasoningEffort)
  if (requested === -1 || supported.length === 0) return undefined
  const below = supported.filter((variant) => EFFORT_ORDER.indexOf(variant) <= requested)
  return below.at(-1) ?? supported[0]
}

const BASE_URL = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[0-9a-f]{32}\/ai\/v1$/

/** The Workers AI endpoint for one account. */
export function workersAiBaseUrl(accountId: string): Result<string, string> {
  if (!/^[0-9a-f]{32}$/.test(accountId)) return err('The Cloudflare account ID must have 32 hexadecimal characters.')
  return ok(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`)
}

/**
 * True only for a Workers AI account endpoint.
 *
 * Copying a provider's `baseURL` would let a configuration send its API key
 * anywhere, so only this exact shape is copied with the key.
 */
export function isWorkersAiBaseUrl(value: unknown): value is string {
  return typeof value === 'string' && BASE_URL.test(value)
}
