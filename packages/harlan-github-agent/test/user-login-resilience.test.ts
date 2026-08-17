import type { ConsolaInstance } from 'consola'
import type { GitHubUserAccess } from '../src/github-user-access.ts'
import { describe, expect, it, vi } from 'vitest'
import { resolveUserLogin } from '../src/service.ts'

const silentLogger = { info: (() => undefined) as unknown as ConsolaInstance['info'] }

function userAccess(login: () => Promise<string>): Pick<GitHubUserAccess, 'login'> {
  return { login }
}

describe('resolveUserLogin', () => {
  it('accepts the first answer', async () => {
    const result = await resolveUserLogin(userAccess(() => Promise.resolve('harlan-zw')), silentLogger, 3, 1)
    expect(result).toEqual({ _tag: 'Ok', value: 'harlan-zw' })
  })

  it('keeps trying while GitHub is degraded', async () => {
    let calls = 0
    const result = await resolveUserLogin(userAccess(() => {
      calls += 1
      return calls < 3
        ? Promise.reject(new Error('Command failed: gh api user --jq .login'))
        : Promise.resolve('harlan-zw')
    }), silentLogger, 3, 1)

    expect(calls).toBe(3)
    expect(result).toEqual({ _tag: 'Ok', value: 'harlan-zw' })
  })

  it('reports the last failure instead of throwing out of start', async () => {
    const result = await resolveUserLogin(
      userAccess(() => Promise.reject(new Error('Command failed: gh api user --jq .login'))),
      silentLogger,
      2,
      1,
    )
    expect(result).toEqual({ _tag: 'Err', error: 'Command failed: gh api user --jq .login' })
  })

  it('treats an empty answer as no answer', async () => {
    const result = await resolveUserLogin(userAccess(() => Promise.resolve('  ')), silentLogger, 1, 1)
    expect(result._tag).toBe('Err')
  })

  /**
   * The retry wait must keep the event loop alive. An unreferenced timer here
   * lets Node drain its loop and exit cleanly in the middle of starting, which
   * looks exactly like a healthy shutdown and restarts forever under systemd.
   */
  it('holds the event loop open while it waits between attempts', async () => {
    const timers: Array<{ unref: unknown }> = []
    const original = globalThis.setTimeout
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: never, timeout: never, ...rest: never[]) => {
      const timer = original(handler, timeout, ...rest)
      timers.push(timer as unknown as { unref: unknown })
      return timer
    }) as typeof globalThis.setTimeout)

    try {
      let calls = 0
      await resolveUserLogin(userAccess(() => {
        calls += 1
        return calls < 2 ? Promise.reject(new Error('degraded')) : Promise.resolve('harlan-zw')
      }), silentLogger, 2, 1)
      expect(timers.length).toBeGreaterThan(0)
      expect(timers.every(timer => (timer as unknown as { hasRef: () => boolean }).hasRef())).toBe(true)
    }
    finally {
      spy.mockRestore()
    }
  })
})
