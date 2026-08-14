import { describe, expect, it } from 'vitest'
import { createAgentPermitPool } from '../src/agent-permit-pool.ts'

describe('agent permit pool', () => {
  it('allows no more than the configured active agents', () => {
    const pool = createAgentPermitPool(2)
    const first = pool.tryAcquire()
    const second = pool.tryAcquire()

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(pool.tryAcquire()).toBeNull()

    first?.release()
    expect(pool.tryAcquire()).not.toBeNull()
  })
})
