import { describe, expect, it } from 'vitest'
import { createAgentPermitPool, createRoutinePermitPools } from '../src/agent-permit-pool.ts'

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

  it('gives a waiting Routine the next released permit without interrupting active Agents', () => {
    let overdue = false
    const pools = createRoutinePermitPools(createAgentPermitPool(2), () => overdue)
    const first = pools.items.tryAcquire()
    const second = pools.items.tryAcquire()
    overdue = true

    expect(pools.routines.tryAcquire()).toBeNull()
    first?.release()
    expect(pools.items.tryAcquire()).toBeNull()
    const routine = pools.routines.tryAcquire()
    expect(routine).not.toBeNull()
    expect(pools.items.tryAcquire()).toBeNull()

    second?.release()
    const review = pools.items.tryAcquire()
    expect(review).not.toBeNull()
    expect(pools.routines.tryAcquire()).toBeNull()

    routine?.release()
    routine?.release()
    expect(pools.items.tryAcquire()).toBeNull()
    const nextRoutine = pools.routines.tryAcquire()
    expect(nextRoutine).not.toBeNull()
    expect(pools.items.tryAcquire()).toBeNull()
    review?.release()
    expect(pools.items.tryAcquire()).not.toBeNull()
  })

  it('releases the reserved permit when waiting work is disabled', () => {
    let overdue = true
    const pools = createRoutinePermitPools(createAgentPermitPool(1), () => overdue)
    expect(pools.items.tryAcquire()).toBeNull()

    overdue = false
    const review = pools.items.tryAcquire()
    expect(review).not.toBeNull()
    expect(pools.routines.tryAcquire()).toBeNull()
    review?.release()
    expect(pools.items.tryAcquire()).not.toBeNull()
  })
})
