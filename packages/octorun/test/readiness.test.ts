import type { ClaudeAuthenticationOptions } from '../src/readiness.ts'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { checkClaudeAuthentication, withClaudeReadiness } from '../src/readiness.ts'

function fixture(scenario: string): ClaudeAuthenticationOptions {
  return {
    command: process.execPath,
    args: ['--experimental-strip-types', fileURLToPath(new URL('./fixtures/claude-auth.ts', import.meta.url))],
    env: { ...process.env, KIT_AUTH_SCENARIO: scenario },
    timeoutMs: 2000,
  }
}

it('confirms authentication without returning account details', async () => {
  expect(await checkClaudeAuthentication(fixture('login'))).toEqual({ _tag: 'Ok', value: { authenticated: true } })
})

it.each(['logout', 'failure'])('reports %s without exposing captured output', async (scenario) => {
  const result = await checkClaudeAuthentication(fixture(scenario))
  expect(result).toMatchObject({ _tag: 'Err', error: { _tag: 'Authorization', message: expect.stringContaining('claude auth login') } })
  expect(JSON.stringify(result)).not.toContain('private')
})

it.each(['invalid', 'missing-status', 'oversize'])('rejects a %s authentication response', async (scenario) => {
  expect(await checkClaudeAuthentication(fixture(scenario))).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
})

it('limits an unresponsive authentication process', async () => {
  expect(await checkClaudeAuthentication({ ...fixture('timeout'), timeoutMs: 50 })).toMatchObject({ _tag: 'Err', error: { _tag: 'Transient' } })
})

it('reports a missing executable as a configuration error', async () => {
  expect(await checkClaudeAuthentication({ command: '/missing/claude/executable' })).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration', message: expect.stringContaining('PATH') } })
})

it('refuses an invalid process timeout before execution', async () => {
  expect(await checkClaudeAuthentication({ timeoutMs: 0 })).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
})

it('keeps App failures unready when Claude authentication succeeds', () => {
  expect(withClaudeReadiness({ _tag: 'Ok', value: { ready: false, provider: { model: 'test' } } }, { _tag: 'Ok', value: { authenticated: true } })).toMatchObject({
    _tag: 'Ok',
    value: { ready: false, provider: { configured: true, authenticated: true } },
  })
})

it('makes missing Claude authentication visible without hiding the App diagnostic', () => {
  expect(withClaudeReadiness({ _tag: 'Ok', value: { ready: true, repositories: ['checked'], provider: { model: 'test' } } }, { _tag: 'Err', error: { _tag: 'Authorization', message: 'Sign in.' } })).toMatchObject({
    _tag: 'Ok',
    value: { ready: false, repositories: ['checked'], provider: { model: 'test', configured: false, authenticated: false, error: 'Sign in.' } },
  })
})
