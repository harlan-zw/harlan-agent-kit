import { describe, expect, it } from 'vitest'
import { digest, matchesWorkflow, parseEvent, parseWorkflow, resolveTaskInputs, targetKey } from '../src/index.ts'

const definition = (tasks: unknown[] = [{ id: 'first', uses: 'echo', with: { text: 'hello' } }]) => ({ version: 1, id: 'example', name: 'Example', on: [{ event: 'pull_request' }], tasks })
const event = () => ({ id: 'delivery-1', semanticKey: 'head-1', source: 'webhook', name: 'pull_request', action: 'opened', repository: { id: 1, fullName: 'acme/project', installationId: 2 }, actor: { id: 3, login: 'sam', kind: 'User' }, target: { _tag: 'PullRequest', number: 4, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }, occurredAt: '2026-10-21T00:00:00.000Z', receivedAt: '2026-10-21T00:00:01.000Z', data: { draft: false } })

describe('workflow definitions', () => {
  it('parses defaults and selects an event by its name and action', () => {
    const parsed = parseWorkflow(definition())
    const input = parseEvent(event())
    expect(parsed._tag).toBe('Ok')
    expect(input._tag).toBe('Ok')
    if (parsed._tag !== 'Ok' || input._tag !== 'Ok')
      throw new Error('Fixture was rejected.')
    expect(parsed.value.limits.maxAttempts).toBe(3)
    expect(matchesWorkflow(parsed.value, input.value)).toBe(true)
    expect(matchesWorkflow({ ...parsed.value, on: [{ event: 'pull_request', actions: ['closed'] }] }, input.value)).toBe(false)
  })

  it.each([
    definition([{ id: 'same', uses: 'echo', with: {} }, { id: 'same', uses: 'echo', with: {} }]),
    definition([{ id: 'first', uses: 'echo', with: { value: { $ref: 'tasks.later.output' } } }, { id: 'later', uses: 'echo', with: {} }]),
    definition([{ id: 'first', uses: 'echo', with: { value: { $ref: 'tasks.first.output' } } }]),
    definition([{ id: 'first', uses: 'echo', with: { value: { $ref: 'event.__proto__.secret' } } }]),
    { ...definition(), execute: 'arbitrary-code' },
    { ...definition(), limits: { maxAttempts: 0 } },
    { ...definition(), concurrency: { mode: 'unknown' } },
  ])('rejects unsafe or ambiguous configuration', (input) => {
    expect(parseWorkflow(input)).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
  })

  it('resolves prior outputs and event values without evaluating code', () => {
    const parsed = parseEvent(event())
    if (parsed._tag !== 'Ok')
      throw new Error('Fixture was rejected.')
    expect(resolveTaskInputs({ text: { $ref: 'tasks.first.output.message' }, draft: { $ref: 'event.data.draft' }, nested: [{ $ref: 'event.repository.fullName' }] }, { first: { message: 'ok' } }, parsed.value)).toEqual({ _tag: 'Ok', value: { text: 'ok', draft: false, nested: ['acme/project'] } })
    expect(resolveTaskInputs({ missing: { $ref: 'tasks.first.output.absent' } }, { first: {} }, parsed.value)).toMatchObject({ _tag: 'Err' })
  })
})

describe('event boundaries', () => {
  it.each([
    { ...event(), repository: { id: 1, installationId: 2, fullName: '../../private' } },
    { ...event(), target: { _tag: 'PullRequest', number: 4, headSha: 'not-a-sha', baseSha: 'b'.repeat(40) } },
    { ...event(), occurredAt: 'invalid' },
    { ...event(), data: JSON.parse('{"__proto__":{"secret":true}}') },
  ])('rejects malformed external input', (input) => {
    expect(parseEvent(input)).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
  })

  it('keeps repository and pull request target identity separate from revision identity', () => {
    const parsed = parseEvent(event())
    if (parsed._tag !== 'Ok')
      throw new Error('Fixture was rejected.')
    expect(targetKey(parsed.value)).toBe('1:pull_request:4')
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }))
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }))
  })
})
