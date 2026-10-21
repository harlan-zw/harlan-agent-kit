import type { AgentRequest } from '../src/types.ts'
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createOpenAICompatibleProvider } from '../src/providers.ts'

function request(signal = new AbortController().signal): AgentRequest {
  return {
    messages: [{ role: 'user', content: 'Review this patch.' }],
    maxOutputTokens: 128,
    signal,
  }
}

describe('agent provider over HTTP', () => {
  it('completes a real HTTP request against an operator-selected local endpoint', async () => {
    let authorization: string | undefined
    const server = createServer((incoming, outgoing) => {
      authorization = incoming.headers.authorization
      incoming.resume()
      outgoing.setHeader('content-type', 'application/json')
      outgoing.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Local response.' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    await (async () => {
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('The local provider server did not bind.')
      const provider = createOpenAICompatibleProvider({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'local', apiKey: 'local-key' })
      if (provider._tag === 'Err')
        throw new Error(provider.error.message)
      expect(await provider.value.generate(request())).toMatchObject({ _tag: 'Ok', value: { text: 'Local response.', usage: { inputTokens: 10, outputTokens: 3 } } })
      expect(authorization).toBe('Bearer local-key')
    })().finally(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  })

  it('sends a bounded text-only turn and returns reported usage', async () => {
    const calls: Request[] = []
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://models.example/v1/', model: 'review-model', apiKey: 'secret' }, {
      fetch: async (input, init) => {
        calls.push(new Request(input, init))
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'No findings.' } }], usage: { prompt_tokens: 19, completion_tokens: 7 } })
      },
    })
    expect(provider._tag).toBe('Ok')
    if (provider._tag === 'Err')
      return
    expect(await provider.value.generate(request())).toEqual({ _tag: 'Ok', value: { text: 'No findings.', usage: { inputTokens: 19, outputTokens: 7, costUsd: null } } })
    expect(calls[0]?.url).toBe('https://models.example/v1/chat/completions')
    expect(await calls[0]?.json()).toEqual({ model: 'review-model', messages: [{ role: 'user', content: 'Review this patch.' }], max_completion_tokens: 128, stream: false, store: false })
    expect(calls[0]?.redirect).toBe('error')
  })

  it.each([
    [401, 'Authorization', 'authentication'],
    [403, 'Authorization', 'authentication'],
    [429, 'Capacity', 'quota'],
    [500, 'Transient', 'transient'],
    [400, 'Configuration', 'configuration'],
  ])('classifies status %i without returning provider response secrets', async (status, tag, code) => {
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://models.example/v1', model: 'review-model', apiKey: 'secret' }, {
      fetch: async () => new Response('secret provider response', { status }),
      now: () => new Date('2026-10-21T00:00:00Z'),
    })
    if (provider._tag === 'Err')
      throw new Error(provider.error.message)
    const result = await provider.value.generate(request())
    expect(result).toMatchObject({ _tag: 'Err', error: { _tag: tag, code, status } })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it.each([
    { choices: [{ message: { content: 'answer' }, finish_reason: 'length' }], usage: { prompt_tokens: 1, completion_tokens: 128 } },
    { choices: [{ message: { content: 'answer', tool_calls: [{}] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    { choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: -1, completion_tokens: 1 } },
    { choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] },
  ])('rejects incomplete, tool, and unaccounted responses', async (body) => {
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://models.example/v1', model: 'review-model', apiKey: 'secret' }, { fetch: async () => Response.json(body) })
    if (provider._tag === 'Err')
      throw new Error(provider.error.message)
    expect(await provider.value.generate(request())).toMatchObject({ _tag: 'Err', error: { _tag: 'Permanent', code: 'invalid-response' } })
  })

  it.each([null, []])('accepts an empty tool field on a text response', async (toolCalls) => {
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://models.example/v1', model: 'review-model', apiKey: 'secret' }, {
      fetch: async () => Response.json({ choices: [{ message: { content: 'Text response.', tool_calls: toolCalls, function_call: null }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } }),
    })
    if (provider._tag === 'Err')
      throw new Error(provider.error.message)
    expect(await provider.value.generate(request())).toMatchObject({ _tag: 'Ok', value: { text: 'Text response.' } })
  })

  it('cancels an oversized streamed response before parsing', async () => {
    let cancelled = false
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://models.example/v1', model: 'review-model', apiKey: 'secret', maxResponseBytes: 1024 }, {
      fetch: async () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(2048)) },
        cancel() { cancelled = true },
      })),
    })
    if (provider._tag === 'Err')
      throw new Error(provider.error.message)
    expect(await provider.value.generate(request())).toMatchObject({ _tag: 'Err', error: { code: 'invalid-response' } })
    expect(cancelled).toBe(true)
  })

  it('retains paid usage when a completion reaches its output limit', async () => {
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://models.example/v1', model: 'review-model', apiKey: 'secret' }, {
      fetch: async () => Response.json({ choices: [{ message: { content: 'incomplete' }, finish_reason: 'length' }], usage: { prompt_tokens: 200, completion_tokens: 128 } }),
    })
    if (provider._tag === 'Err')
      throw new Error(provider.error.message)
    expect(await provider.value.generate(request())).toMatchObject({ _tag: 'Err', error: { code: 'invalid-response', usage: { inputTokens: 200, outputTokens: 128, costUsd: null } } })
  })

  it('aborts a stalled provider using the configured timeout', async () => {
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://models.example/v1', model: 'review-model', apiKey: 'secret', timeoutMs: 20 }, {
      fetch: async (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    })
    if (provider._tag === 'Err')
      throw new Error(provider.error.message)
    expect(await provider.value.generate(request())).toMatchObject({ _tag: 'Err', error: { _tag: 'Transient', code: 'timeout' } })
  })

  it('rejects insecure remote URLs and empty credentials before transport', () => {
    expect(createOpenAICompatibleProvider({ baseUrl: 'http://remote.example', model: 'model', apiKey: 'key' })).toMatchObject({ _tag: 'Err', error: { code: 'configuration' } })
    expect(createOpenAICompatibleProvider({ baseUrl: 'https://models.example', model: 'model', apiKey: '' })).toMatchObject({ _tag: 'Err', error: { code: 'configuration' } })
  })

  it('does not invoke transport for a cancelled turn or oversized input', async () => {
    let calls = 0
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://models.example/v1', model: 'review-model', apiKey: 'secret', maxInputCharacters: 1024 }, {
      fetch: async () => {
        calls++
        throw new Error('Transport must not run')
      },
    })
    if (provider._tag === 'Err')
      throw new Error(provider.error.message)
    const controller = new AbortController()
    controller.abort()
    expect(await provider.value.generate(request(controller.signal))).toMatchObject({ _tag: 'Err', error: { code: 'cancelled' } })
    expect(await provider.value.generate({ ...request(), messages: [{ role: 'user', content: 'x'.repeat(1025) }] })).toMatchObject({ _tag: 'Err', error: { code: 'configuration' } })
    expect(calls).toBe(0)
  })
})
