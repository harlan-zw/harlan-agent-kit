import { describe, expect, it } from 'vitest'
import { handleRequest } from '../src/app.ts'
import { CONTROLLER_ORIGIN } from '../src/dashboard.ts'
import { ORIGIN, READY_SETUP, createTestEdge } from './fixtures.ts'

describe('dashboard proxy', () => {
  it('sends a read to the controller under its own Host, keeping the path and query', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    const response = await handleRequest(new Request(`${ORIGIN}/api/state?limit=5`), edge.dependencies)

    expect(await response.text()).toBe('dashboard')
    expect(edge.dashboard[0]).toMatchObject({
      url: 'http://wolfstar-github-agent.localhost/api/state?limit=5',
      method: 'GET',
    })
  })

  it('translates the exact public Origin on a write and keeps the body', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    await handleRequest(
      new Request(`${ORIGIN}/api/pause`, { method: 'POST', headers: { origin: ORIGIN }, body: '{"paused":true}' }),
      edge.dependencies,
    )

    expect(edge.dashboard[0]?.headers.get('origin')).toBe(CONTROLLER_ORIGIN)
    expect(edge.dashboard[0]?.body).toBe('{"paused":true}')
  })

  it('refuses a write with a missing or foreign Origin before the controller sees it', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    for (const headers of [{}, { origin: 'https://evil.example' }, { origin: CONTROLLER_ORIGIN }]) {
      const response = await handleRequest(
        new Request(`${ORIGIN}/api/pause`, { method: 'POST', headers }),
        edge.dependencies,
      )
      expect(response.status).toBe(403)
    }
    expect(edge.dashboard).toHaveLength(0)
  })

  it('passes the Authorization header through, because the controller checks the password', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    await handleRequest(
      new Request(`${ORIGIN}/`, { headers: { authorization: 'Basic YWdlbnQ6eA==' } }),
      edge.dependencies,
    )

    expect(edge.dashboard[0]?.headers.get('authorization')).toBe('Basic YWdlbnQ6eA==')
  })

  it('redirects plain HTTP to HTTPS', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    const response = await handleRequest(new Request('http://agent.example.com/history?x=1'), edge.dependencies)

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('https://agent.example.com/history?x=1')
  })

  it('sends every dashboard path to setup until setup is complete', async () => {
    const edge = createTestEdge()

    const response = await handleRequest(new Request(`${ORIGIN}/history`), edge.dependencies)

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(`${ORIGIN}/setup`)
    expect(edge.dashboard).toHaveLength(0)
  })
})
