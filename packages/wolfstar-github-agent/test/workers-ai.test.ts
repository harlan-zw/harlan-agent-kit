import { describe, expect, it } from 'vitest'
import { AGENT_MODELS, parseAgentSelection } from '../src/agent-profile.ts'
import {
  WORKERS_AI_MODELS,
  WORKERS_AI_VARIANTS,
  isWorkersAiBaseUrl,
  isWorkersAiModel,
  workersAiBaseUrl,
  workersAiVariant,
} from '../src/workers-ai.ts'

const ACCOUNT = '0123456789abcdef0123456789abcdef'

describe('Workers AI models', () => {
  it('lists every Workers AI model under opencode, once, with its variants', () => {
    expect(new Set(WORKERS_AI_MODELS).size).toBe(WORKERS_AI_MODELS.length)
    expect(Object.keys(WORKERS_AI_VARIANTS).sort()).toEqual([...WORKERS_AI_MODELS].sort())
    for (const model of WORKERS_AI_MODELS) expect(AGENT_MODELS.opencode).toContain(model)
  })

  it('accepts a pinned Workers AI model in the Agent selection', () => {
    const selection = parseAgentSelection({
      _tag: 'Pinned',
      provider: 'opencode',
      model: 'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code',
    })

    expect(selection._tag).toBe('Ok')
  })

  it('tells Workers AI models apart from the other opencode routes', () => {
    expect(isWorkersAiModel('cloudflare-workers-ai/@cf/zai-org/glm-5.3')).toBe(true)
    expect(isWorkersAiModel('zai-coding-plan/glm-5.3')).toBe(false)
    expect(isWorkersAiModel('cloudflare-workers-ai/@cf/unknown/model')).toBe(false)
  })
})

describe('Workers AI variants', () => {
  it('keeps an effort the model exposes', () => {
    expect(workersAiVariant('cloudflare-workers-ai/@cf/qwen/qwen3.8-27b', 'xhigh')).toBe('xhigh')
  })

  it('steps down to the closest variant below, then up to the lowest the model has', () => {
    expect(workersAiVariant('cloudflare-workers-ai/@cf/qwen/qwen3.8-27b', 'high')).toBe('medium')
    expect(workersAiVariant('cloudflare-workers-ai/@cf/openai/gpt-oss-120b', 'max')).toBe('high')
    expect(workersAiVariant('cloudflare-workers-ai/@cf/openai/gpt-oss-120b', 'none')).toBe('low')
  })

  it('runs without a variant when the model has none or the effort is unknown', () => {
    expect(workersAiVariant('cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code', 'high')).toBeUndefined()
    expect(workersAiVariant('cloudflare-workers-ai/@cf/zai-org/glm-5.3', undefined)).toBeUndefined()
    expect(workersAiVariant('cloudflare-workers-ai/@cf/zai-org/glm-5.3', 'turbo')).toBeUndefined()
  })
})

describe('Workers AI endpoint', () => {
  it('builds the account endpoint and refuses anything that is not an account ID', () => {
    expect(workersAiBaseUrl(ACCOUNT)).toEqual({
      _tag: 'Ok',
      value: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1`,
    })
    expect(workersAiBaseUrl('not-an-account')._tag).toBe('Err')
  })

  it('recognises only the exact Workers AI endpoint', () => {
    expect(isWorkersAiBaseUrl(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1`)).toBe(true)
    for (const other of [
      `http://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1`,
      `https://api.cloudflare.com.evil.example/client/v4/accounts/${ACCOUNT}/ai/v1`,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1/../../x`,
      'https://evil.example/ai/v1',
      undefined,
    ])
      expect(isWorkersAiBaseUrl(other)).toBe(false)
  })
})
