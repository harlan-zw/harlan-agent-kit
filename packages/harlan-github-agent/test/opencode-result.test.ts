import { expect, it } from 'vitest'
import { MEDIA_LIMITS } from '../src/github-media-limits.ts'
import { createOpencodeSession, readOpencodeMessages, recoverOpencodeResult } from '../src/opencode-result.ts'

const input = { url: 'http://127.0.0.1:4097', password: 'fixture-password', workspace: '/tmp/worktree', sessionId: 'ses_one', signal: new AbortController().signal }
const user = { info: { id: 'msg_user', sessionID: 'ses_one', role: 'user' }, parts: [] }
function assistant(id: string, created: number, finish = 'stop') {
  return { info: { id, sessionID: 'ses_one', role: 'assistant', parentID: 'msg_user', finish, time: { created, completed: created + 1 } }, parts: [
    { id: `text_${id}`, messageID: id, sessionID: 'ses_one', type: 'text', text: '{"answer":"done"}', time: { end: created + 1 } },
    { id: `finish_${id}`, messageID: id, sessionID: 'ses_one', type: 'step-finish', reason: finish, tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 4, write: 1 } } },
  ] }
}

it('recovers later assistant steps for the same parent and skips streamed usage identities', () => {
  const earlier = assistant('msg_first', 1, 'tool-calls')
  const final = assistant('msg_final', 3)
  const result = recoverOpencodeResult([final, user, earlier], 'ses_one', 'msg_first', new Set(['text_msg_first', 'finish_msg_first']))
  expect(result).toEqual({ _tag: 'Ok', value: [
    { type: 'text', sessionID: 'ses_one', part: final.parts[0] },
    { type: 'step_finish', sessionID: 'ses_one', part: final.parts[1] },
  ] })
})

it.each([
  { name: 'empty answer', mutate: (message: ReturnType<typeof assistant>) => { message.parts[0]!.text = '' } },
  { name: 'negative tokens', mutate: (message: ReturnType<typeof assistant>) => { message.parts[1]!.tokens!.input = -1 } },
  { name: 'part identity mismatch', mutate: (message: ReturnType<typeof assistant>) => { message.parts[0]!.messageID = 'msg_other' } },
])('rejects $name', ({ mutate }) => {
  const message = assistant('msg_final', 1)
  mutate(message)
  expect(recoverOpencodeResult([user, message], 'ses_one', 'msg_final', new Set())).toMatchObject({ _tag: 'Err' })
})

it('creates an empty session with the exact workspace and owned-server authorization', async () => {
  const calls: Array<{ url: string, authorization: string | null, body: unknown }> = []
  const result = await createOpencodeSession({ ...input, fetch: async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization'), body: JSON.parse(init!.body as string) })
    return Response.json({ id: 'ses_fresh' })
  } })
  expect(result).toEqual({ _tag: 'Ok', value: 'ses_fresh' })
  expect(calls).toEqual([{ url: 'http://127.0.0.1:4097/session?directory=%2Ftmp%2Fworktree', authorization: `Basic ${Buffer.from('opencode:fixture-password').toString('base64')}`, body: { permission: ['question', 'plan_enter', 'plan_exit'].map(permission => ({ permission, pattern: '*', action: 'deny' })) } }])
})

it('starts a check-in that writes its assigned state directory without asking for permission', async () => {
  const stateDirectory = '/home/agent/.local/state/daily-checkin/owner/site'
  const result = await createOpencodeSession({ ...input, stateDirectory, fetch: async (_url, init) => {
    const { permission } = JSON.parse(init!.body as string)
    const allowed = permission.some((rule: { permission: string, pattern: string, action: string }) =>
      rule.permission === 'external_directory' && rule.pattern === `${stateDirectory}/*` && rule.action === 'allow',
    )
    return allowed ? Response.json({ id: 'ses_checkin' }) : Response.json({ error: 'Waiting for directory permission.' }, { status: 409 })
  } })
  expect(result).toEqual({ _tag: 'Ok', value: 'ses_checkin' })
})

it('keeps Review tools restricted when a state directory is supplied', async () => {
  const result = await createOpencodeSession({ ...input, stateDirectory: '/state', reviewTools: ['controller_review_read'], fetch: async (_url, init) => {
    expect(JSON.parse(init!.body as string)).toEqual({ permission: [
      { permission: '*', pattern: '*', action: 'deny' },
      { permission: 'controller_review_read', pattern: '*', action: 'allow' },
    ] })
    return Response.json({ id: 'ses_review' })
  } })
  expect(result).toEqual({ _tag: 'Ok', value: 'ses_review' })
})

it.each(['running', 'pending', 'completed', 'error'])('rejects unfinished or malformed %s tool activity', (status) => {
  const message = assistant('msg_final', 1)
  const tool = { id: 'tool_one', messageID: message.info.id, sessionID: 'ses_one', type: 'tool', tool: 'bash', state: { status, input: { command: 'pnpm test' }, time: { start: 1, end: 2 } } }
  expect(recoverOpencodeResult([user, { ...message, parts: [tool, ...message.parts] }], 'ses_one', undefined, new Set())).toMatchObject({ _tag: 'Err' })
})

it('recovers completed error tool output through the existing event shape', () => {
  const message = assistant('msg_final', 1)
  const tool = { id: 'tool_one', messageID: message.info.id, sessionID: 'ses_one', type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'pnpm test' }, error: 'test failed', time: { start: 1, end: 2 } } }
  expect(recoverOpencodeResult([user, { ...message, parts: [tool, ...message.parts] }], 'ses_one', undefined, new Set())).toMatchObject({ _tag: 'Ok', value: [{ type: 'tool_use', part: tool }, { type: 'text' }, { type: 'step_finish' }] })
})

it.each([
  { name: 'HTTP error', response: () => new Response('private payload', { status: 500 }) },
  { name: 'invalid JSON', response: () => new Response('broken', { headers: { 'content-type': 'application/json' } }) },
  { name: 'oversized body', response: () => new Response(' '.repeat(32 * 1024 * 1024), { headers: { 'content-type': 'application/json' } }) },
])('rejects $name at the result read boundary', async ({ response }) => {
  const result = await readOpencodeMessages({ ...input, fetch: async () => response() })
  expect(result).toMatchObject({ _tag: 'Err' })
})

it('recovers an allowed media response whose base64 user parts exceed eight MiB', async () => {
  const message = assistant('msg_final', 1)
  const mediaUser = { ...user, parts: Array.from({ length: MEDIA_LIMITS.totalBytes / MEDIA_LIMITS.imageBytes }, () => ({ type: 'file', url: `data:image/png;base64,${Buffer.alloc(MEDIA_LIMITS.imageBytes).toString('base64')}` })) }
  const read = await readOpencodeMessages({ ...input, fetch: async () => Response.json([mediaUser, message]) })
  expect(read._tag).toBe('Ok')
  if (read._tag === 'Err')
    throw new Error(read.error)
  expect(recoverOpencodeResult(read.value, 'ses_one', undefined, new Set())).toEqual({ _tag: 'Ok', value: [
    { type: 'text', sessionID: 'ses_one', part: message.parts[0] },
    { type: 'step_finish', sessionID: 'ses_one', part: message.parts[1] },
  ] })
})

it('rejects redirect or infrastructure failures without exposing auth-bearing error data', async () => {
  const result = await readOpencodeMessages({ ...input, fetch: async (_url, init) => {
    expect(init?.redirect).toBe('error')
    throw new Error('fixture-password private payload')
  } })
  expect(result).toEqual({ _tag: 'Err', error: 'The OpenCode result read failed.' })
})

it('rejects an aborted read even if a transport supplies a response', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await readOpencodeMessages({ ...input, signal: controller.signal, fetch: async () => Response.json([]) })
  expect(result).toEqual({ _tag: 'Err', error: 'The OpenCode result read was cancelled.' })
})
