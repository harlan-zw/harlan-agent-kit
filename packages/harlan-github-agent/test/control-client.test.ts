import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { createControlClient } from '../src/index.ts'
import { dashboardSnapshot } from './fixtures.ts'

const baseUrl = 'https://hogwild.example.test'
const password = 'test-password-with-at-least-32-bytes'

function clientWith(responses: Response[], requests: Request[]) {
  return createControlClient({
    authentication: { _tag: 'Basic', password },
    baseUrl,
    fetch: async (input, init) => {
      requests.push(new Request(input, init))
      const response = responses.shift()
      if (response === undefined)
        throw new Error('No response was prepared.')
      return response
    },
  })
}

describe('harlan GitHub Agent control client', () => {
  it('reads health before the shared dashboard state', async () => {
    const requests: Request[] = []
    const snapshot = dashboardSnapshot()
    const created = clientWith([
      Response.json({ status: 'ready', mutationsEnabled: false, repositories: 2, issues: 3, pullRequests: 4, tasks: 5 }),
      Response.json(snapshot),
    ], requests)

    expect(created._tag).toBe('Ok')
    if (created._tag === 'Err')
      return
    const result = await created.value.status()

    expect(result).toEqual({
      _tag: 'Ok',
      value: {
        health: { status: 'ready', mutationsEnabled: false, repositories: 2, issues: 3, pullRequests: 4, tasks: 5 },
        state: snapshot,
      },
    })
    expect(requests.map(request => request.url)).toEqual([
      `${baseUrl}/health`,
      `${baseUrl}/api/state`,
    ])
    expect(requests[0]?.headers.get('authorization')).toBe(`Basic ${Buffer.from(`agent:${password}`).toString('base64')}`)
  })

  it('sends one guarded Restart request through the existing control API', async () => {
    const requests: Request[] = []
    const accepted = {
      _tag: 'Requested' as const,
      id: 'request-1',
      source: 'helper' as const,
      operation: { _tag: 'Restart' as const },
      requestedAt: '2026-09-02T01:00:00.000Z',
    }
    const created = clientWith([Response.json(accepted, { status: 202 })], requests)

    expect(created._tag).toBe('Ok')
    if (created._tag === 'Err')
      return
    const result = await created.value.restart()

    expect(result).toEqual({ _tag: 'Ok', value: accepted })
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.headers.get('origin')).toBe(baseUrl)
    await expect(requests[0]?.json()).resolves.toEqual({ source: 'helper' })
  })

  it('returns an HTTP failure as a value', async () => {
    const created = clientWith([
      Response.json({ message: 'The task already finished.' }, { status: 409 }),
    ], [])

    expect(created._tag).toBe('Ok')
    if (created._tag === 'Err')
      return
    const result = await created.value.cancelTask('a'.repeat(64))

    expect(result).toEqual({
      _tag: 'Err',
      error: { _tag: 'HttpFailure', status: 409, message: 'The task already finished.' },
    })
  })
})
