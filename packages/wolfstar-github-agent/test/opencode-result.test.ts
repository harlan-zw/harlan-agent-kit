import { expect, it } from 'vitest'
import {
  createOpencodeSession,
  opencodeDeliveryKey,
  readOpencodeMessages,
  recoverOpencodeResult,
  waitOpencodeReviewTools,
} from '../src/opencode-result.ts'

it('waits for Review MCP discovery before admitting a prompt', async () => {
  let reads = 0
  const result = await waitOpencodeReviewTools({
    ...input,
    fetch: async () => {
      reads++
      return Response.json({
        data: reads === 1 ? [] : [{ name: 'controller_review', status: { status: 'connected' } }],
      })
    },
  })
  expect(result).toEqual({ _tag: 'Ok', value: undefined })
  expect(reads).toBe(2)
})

it('refuses a failed Review MCP server', async () => {
  const result = await waitOpencodeReviewTools({
    ...input,
    fetch: async () =>
      Response.json({ data: [{ name: 'controller_review', status: { status: 'failed', error: 'private details' } }] }),
  })
  expect(result).toEqual({ _tag: 'Err', error: 'The OpenCode Review tools failed to start.' })
})

const input = {
  url: 'http://127.0.0.1:4097',
  password: 'fixture-password',
  workspace: '/tmp/worktree',
  sessionId: 'ses_one',
  signal: new AbortController().signal,
}
const user = { id: 'msg_user', type: 'user', text: 'Check', time: { created: 0 } }
const idle = { id: 'msg_idle', type: 'idle', outcome: 'succeeded', time: { created: 10 } }
function assistant(id = 'msg_final', finish = 'stop') {
  return {
    id,
    type: 'assistant',
    time: { created: 1, completed: 2 },
    finish,
    content: [{ type: 'text', text: '{"answer":"done"}' }],
    tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 4, write: 1 } },
  }
}
function page(data: unknown[], next: string | null = null) {
  return { data, cursor: { next } }
}

it('recovers every assistant step and skips streamed text and token usage', () => {
  const earlier = assistant('msg_first', 'tool-calls')
  const final = assistant()
  const delivered = new Set([
    opencodeDeliveryKey('text', { messageID: earlier.id, text: earlier.content[0]!.text }),
    opencodeDeliveryKey('step_finish', { messageID: earlier.id }),
  ])
  const result = recoverOpencodeResult(page([user, earlier, final, idle]), 'ses_one', earlier.id, delivered)
  expect(result).toMatchObject({
    _tag: 'Ok',
    value: [
      { type: 'text', sessionID: 'ses_one', part: { messageID: final.id, text: '{"answer":"done"}' } },
      { type: 'step_finish', part: { tokens: final.tokens, reason: 'stop' } },
    ],
  })
})

it.each([
  page([]),
  page([user, assistant(), idle], 'more'),
  page([assistant(), idle]),
  page([user, assistant()]),
  page([user, assistant(), { ...idle, outcome: 'failed' }]),
  page([user, { ...assistant(), time: { created: 1 } }, idle]),
  page([user, assistant(), { ...user, id: 'msg_other' }, idle]),
  page([user, { ...assistant(), tokens: { ...assistant().tokens, input: -1 } }, idle]),
  page([user, { ...assistant(), content: [{ type: 'text', text: '' }] }, idle]),
])('refuses incomplete, ambiguous, or malformed persisted results %#', (value) => {
  expect(recoverOpencodeResult(value, 'ses_one', undefined, new Set())).toMatchObject({ _tag: 'Err' })
})

it.each(['completed', 'error'])('recovers %s tool activity once', (status) => {
  const tool = {
    type: 'tool',
    id: 'call_one',
    name: 'shell',
    time: { created: 1, completed: 2 },
    state: {
      status,
      input: { command: 'pnpm test' },
      content: [{ type: 'text', text: 'test output' }],
      error: status === 'error' ? { message: 'test failed' } : undefined,
      metadata: { exit: status === 'error' ? 1 : 0 },
    },
  }
  const message = { ...assistant(), content: [tool, ...assistant().content] }
  const result = recoverOpencodeResult(page([user, message, idle]), 'ses_one', message.id, new Set())
  expect(result).toMatchObject({
    _tag: 'Ok',
    value: [
      { type: 'tool_use', part: { tool: 'shell', state: { status, output: 'test output' } } },
      { type: 'text' },
      { type: 'step_finish' },
    ],
  })
  const delivered = new Set([opencodeDeliveryKey('tool_use', { messageID: message.id, id: tool.id })])
  expect(recoverOpencodeResult(page([user, message, idle]), 'ses_one', message.id, delivered)).toMatchObject({
    _tag: 'Ok',
    value: [{ type: 'text' }, { type: 'step_finish' }],
  })
})

it.each(['running', 'streaming'])('rejects unfinished %s tool activity', (status) => {
  const message = {
    ...assistant(),
    content: [{ type: 'tool', id: 'call_one', name: 'shell', state: { status, input: {} } }, ...assistant().content],
  }
  expect(recoverOpencodeResult(page([user, message, idle]), 'ses_one', undefined, new Set())).toMatchObject({
    _tag: 'Err',
  })
})

it('creates a restricted session in the exact Worktree through the V2 API', async () => {
  const result = await createOpencodeSession({
    ...input,
    reviewTools: ['controller_review_read'],
    fetch: async (url, init) => {
      expect(String(url)).toBe('http://127.0.0.1:4097/api/session')
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Basic ${Buffer.from('opencode:fixture-password').toString('base64')}`,
      )
      expect(JSON.parse(init!.body as string)).toEqual({
        location: { directory: '/tmp/worktree' },
        permissions: [
          { action: '*', resource: '*', effect: 'deny' },
          { action: 'controller_review_read', resource: '*', effect: 'allow' },
        ],
      })
      return Response.json({ data: { id: 'ses_fresh' } })
    },
  })
  expect(result).toEqual({ _tag: 'Ok', value: 'ses_fresh' })
})

it('allows the controller assigned state directory without enabling interactive tools', async () => {
  const result = await createOpencodeSession({
    ...input,
    stateDirectory: '/state',
    fetch: async (_url, init) => {
      const { permissions } = JSON.parse(init!.body as string)
      expect(permissions).toContainEqual({ action: 'external_directory', resource: '/state/*', effect: 'allow' })
      expect(permissions).toContainEqual({ action: 'question', resource: '*', effect: 'deny' })
      return Response.json({ data: { id: 'ses_fresh' } })
    },
  })
  expect(result).toMatchObject({ _tag: 'Ok' })
})

it.each([
  { name: 'HTTP error', response: () => new Response('private payload', { status: 500 }) },
  { name: 'invalid JSON', response: () => new Response('broken', { headers: { 'content-type': 'application/json' } }) },
  {
    name: 'oversized body',
    response: () => new Response(' '.repeat(32 * 1024 * 1024), { headers: { 'content-type': 'application/json' } }),
  },
])('rejects $name at the result read boundary', async ({ response }) => {
  expect(await readOpencodeMessages({ ...input, fetch: async () => response() })).toMatchObject({ _tag: 'Err' })
})

it('reads the owned session with oldest messages first and detects a truncated page', async () => {
  const result = await readOpencodeMessages({
    ...input,
    fetch: async (url) => {
      expect(String(url)).toBe('http://127.0.0.1:4097/api/session/ses_one/message?limit=200&order=asc')
      return Response.json(page([user, assistant(), idle]))
    },
  })
  expect(result._tag === 'Ok' && recoverOpencodeResult(result.value, 'ses_one', undefined, new Set())._tag).toBe('Ok')
})

it('keeps transport failures and cancellation explicit without exposing credentials', async () => {
  const failure = await readOpencodeMessages({
    ...input,
    fetch: async (_url, init) => {
      expect(init?.redirect).toBe('error')
      throw new Error('fixture-password private payload')
    },
  })
  expect(failure).toEqual({ _tag: 'Err', error: 'The OpenCode result read failed.' })
  const controller = new AbortController()
  controller.abort()
  expect(
    await readOpencodeMessages({ ...input, signal: controller.signal, fetch: async () => Response.json([]) }),
  ).toEqual({ _tag: 'Err', error: 'The OpenCode result read was cancelled.' })
})

it('follows bounded V2 pages and rejects repeated cursors', async () => {
  const calls: string[] = []
  const read = await readOpencodeMessages({
    ...input,
    fetch: async (url) => {
      calls.push(String(url))
      return Response.json(calls.length === 1 ? page([user], 'next/page') : page([assistant(), idle]))
    },
  })
  expect(calls[1]).toContain('cursor=next%2Fpage')
  expect(read._tag === 'Ok' && recoverOpencodeResult(read.value, 'ses_one', undefined, new Set())._tag).toBe('Ok')
  expect(
    await readOpencodeMessages({ ...input, fetch: async () => Response.json(page([user], 'repeat')) }),
  ).toMatchObject({ _tag: 'Err' })
})
