import { describe, expect, it } from 'vitest'
import { APIError, choice, jev, noul, score } from '../src/api.ts'

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const answers = {
  billing: { type: 'noul', noul: 0.9 },
  tone: {
    type: 'choice',
    choice: 'calm',
    confidence: 0.8,
    probabilities: { calm: 0.8, angry: 0.2 },
  },
  urgency: {
    type: 'score',
    score: 1.5,
    confidence: 0.7,
    legend: { 0: 'low', 1: 'high' },
    probabilities: { 0: 0.5, 1: 0.5 },
  },
}

const questions = {
  billing: noul('Is this about billing?'),
  tone: choice('Tone?', { calm: null, angry: null }),
  urgency: score('Urgency?', ['low', 'high']),
}

describe('jev api', () => {
  it('wraps the request in the Cloudflare envelope and returns typed answers', async () => {
    const calls: { url: string, init: RequestInit }[] = []
    const client = jev({
      accountId: 'acc-1',
      apiToken: 'k',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! })
        return json({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 2 } })
      },
    })

    const result = await client.systemOne({ state: 'I was charged twice', questions })

    expect(result.answers.billing.noul).toBe(0.9)
    expect(result.answers.tone.choice).toBe('calm')
    expect(result.answers.urgency.legend[1]).toBe('high')

    const { url, init } = calls[0]!
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acc-1/ai/run')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'typesafe/jev',
      input: { state: 'I was charged twice', questions },
    })
  })

  it('routes through a named gateway and honours a model override', async () => {
    let seen: { url: string, init: RequestInit } | undefined
    const client = jev({
      accountId: 'acc-1',
      apiToken: 'k',
      gatewayId: 'jev-prod',
      model: 'typesafe/jev@jev-1.13.0',
      fetch: async (url, init) => {
        seen = { url: String(url), init: init! }
        return json({ model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } })
      },
    })

    await client.systemOne({ state: null, questions: { q: noul() } })

    expect((seen!.init.headers as Record<string, string>)['cf-aig-gateway-id']).toBe('jev-prod')
    expect(JSON.parse(seen!.init.body as string).model).toBe('typesafe/jev@jev-1.13.0')
  })

  it('unwraps a Cloudflare success envelope', async () => {
    const client = jev({
      accountId: 'acc-1',
      apiToken: 'k',
      fetch: async () => json({ success: true, result: { model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } } }),
    })

    const result = await client.systemOne({ state: null, questions: { q: noul() } })

    expect(result.model).toBe('jev-1.13.0')
  })

  it('throws APIError when Cloudflare marks the call failed', async () => {
    const client = jev({
      accountId: 'acc-1',
      apiToken: 'k',
      fetch: async () => json({ success: false, errors: [{ message: 'authentication invalid' }] }),
    })

    const failure = await client.systemOne({ state: null, questions: { q: noul() } }).catch(error => error)

    expect(failure).toBeInstanceOf(APIError)
    expect(failure.status).toBe(200)
    expect(failure.message).toBe('200 [{"message":"authentication invalid"}]')
  })

  it('throws APIError on a non-2xx response', async () => {
    const client = jev({
      accountId: 'acc-1',
      apiToken: 'k',
      fetch: async () => json({ error: { message: 'bad token' } }, 401, { 'cf-ray': 'ray-1' }),
    })

    const failure = await client.systemOne({ state: null, questions: { q: noul() } }).catch(error => error)

    expect(failure).toBeInstanceOf(APIError)
    expect(failure.status).toBe(401)
    expect(failure.requestId).toBe('ray-1')
    expect(failure.message).toBe('401 bad token')
  })

  it('retries rate limits and gives up after the budget', async () => {
    const statuses: number[] = []
    const client = jev({
      accountId: 'acc-1',
      apiToken: 'k',
      retries: 2,
      fetch: async () => {
        statuses.push(429)
        return json({ error: 'rate limited' }, 429, { 'retry-after': '0' })
      },
    })

    const failure = await client.systemOne({ state: null, questions: { q: noul() } }).catch(error => error)

    expect(failure).toBeInstanceOf(APIError)
    expect(failure.status).toBe(429)
    expect(statuses).toHaveLength(3)
  })

  it('recovers when a retry succeeds', async () => {
    let calls = 0
    const client = jev({
      accountId: 'acc-1',
      apiToken: 'k',
      retries: 2,
      fetch: async () => {
        calls++
        return calls === 1
          ? json({ error: 'overloaded' }, 529, { 'retry-after': '0' })
          : json({ model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 0, output_tokens: 0 } })
      },
    })

    const result = await client.systemOne({ state: null, questions: { q: noul() } })

    expect(calls).toBe(2)
    expect(result.answers.q.noul).toBe(0.5)
  })

  it('never retries an authentication failure', async () => {
    let calls = 0
    const client = jev({
      accountId: 'acc-1',
      apiToken: 'k',
      fetch: async () => {
        calls++
        return json({ error: 'bad token' }, 401)
      },
    })

    await client.systemOne({ state: null, questions: { q: noul() } }).catch(() => undefined)

    expect(calls).toBe(1)
  })

  it('reads CLOUDFLARE_* environment variables when options are omitted', async () => {
    const g = globalThis as { process?: { env?: Record<string, string | undefined> } }
    const saved = g.process
    g.process = { env: { CLOUDFLARE_ACCOUNT_ID: ' env-account ', CLOUDFLARE_API_TOKEN: 'env-token' } }
    try {
      let seen: { url: string, init: RequestInit } | undefined
      const client = jev({
        fetch: async (url, init) => {
          seen = { url: String(url), init: init! }
          return json({ model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } })
        },
      })
      await client.systemOne({ state: null, questions: { q: noul() } })
      expect(seen!.url).toBe('https://api.cloudflare.com/client/v4/accounts/env-account/ai/run')
      expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer env-token')

      g.process = { env: { CLOUDFLARE_ACCOUNT_ID: '  ' } }
      expect(() => jev()).toThrow(/CLOUDFLARE_ACCOUNT_ID/)
    }
    finally {
      if (saved === undefined)
        delete g.process
      else
        g.process = saved
    }
  })

  it('validates questions before sending', () => {
    const client = jev({ accountId: 'a', apiToken: 'k', fetch: () => Promise.reject(new Error('no')) })
    expect(() => client.systemOne({ state: null, questions: {} })).toThrow(/at least one/i)
    expect(() =>
      client.systemOne({
        state: null,
        questions: { s: { type: 'score', criteria: ['one'] as never } },
      }),
    ).toThrow(/2 to 10 levels/)
    expect(() =>
      client.systemOne({
        state: null,
        questions: { c: { type: 'choice', criteria: { a: null } } },
      }),
    ).toThrow(/2 to 255 options/)
  })
})
