import { describe, expect, it } from 'vitest'
import { parseDesktopEvents, parseDesktopMemory, parseDesktopReport, parseDesktopWorktree, readDesktopResponse } from '../src/desktop-protocol.ts'

describe('desktop boundaries', () => {
  it('accepts a whole memory limit and refuses malformed settings', () => {
    expect(parseDesktopMemory({ memoryGiB: 16 })).toBe(16)
    for (const value of [null, {}, { memoryGiB: 0 }, { memoryGiB: 1.5 }, { memoryGiB: '16' }, { memoryGiB: 257 }])
      expect(() => parseDesktopMemory(value)).toThrow('Desktop memory must be')
  })
  it('preserves memory committed above a newly lowered limit', () => {
    expect(parseDesktopReport({ memoryGiB: 8, reservedGiB: 16, agents: 1, actions: 1 })).toEqual({ memoryGiB: 8, reservedGiB: 16, agents: 1, actions: 1 })
    expect(() => parseDesktopReport({ memoryGiB: 16, reservedGiB: -1, agents: 0, actions: 0 })).toThrow()
  })
  it('refuses arbitrary provider events and non-GitHub source repositories', () => {
    expect(parseDesktopEvents([{ _tag: 'SessionStarted', sessionId: 'abc' }])).toEqual([{ _tag: 'SessionStarted', sessionId: 'abc' }])
    expect(() => parseDesktopEvents([{ _tag: 'Progress', text: 'bad', percent: 999 }])).toThrow()
    expect(() => parseDesktopWorktree({ head: 'a'.repeat(40), origin: '/tmp/repo', bundle: '', patch: '', files: [] })).toThrow()
  })
})

it('treats a no-content desktop claim as an empty Queue', async () => {
  await expect(readDesktopResponse(new Response(null, { status: 204 }))).resolves.toBeNull()
  await expect(readDesktopResponse(Response.json({ id: 'next-turn' }))).resolves.toEqual({ id: 'next-turn' })
  await expect(readDesktopResponse(new Response('invalid JSON'))).rejects.toThrow()
})
