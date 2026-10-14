import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { terminalDashboardAccess } from '../src/terminal-controller.ts'

function request(credentials: string, publicIngress = false) {
  return {
    headers: {
      authorization: `Basic ${Buffer.from(credentials).toString('base64')}`,
      ...(publicIngress ? { 'x-wolfstar-agent-ingress': 'public' } : {}),
    },
  } as IncomingMessage
}

describe('terminal controller authorization', () => {
  it('refuses malformed credentials that contain no separator', () => {
    expect(terminalDashboardAccess(request('agentx'), 'agentx')).toBe(false)
  })

  it('accepts the private Agent credentials and refuses public ingress', () => {
    expect(terminalDashboardAccess(request('agent:password'), 'password')).toBe(true)
    expect(terminalDashboardAccess(request('agent:password', true), 'password')).toBe(false)
    expect(terminalDashboardAccess(request('other:password'), 'password')).toBe(false)
    expect(terminalDashboardAccess(request('agent:incorrect'), 'password')).toBe(false)
  })
})
