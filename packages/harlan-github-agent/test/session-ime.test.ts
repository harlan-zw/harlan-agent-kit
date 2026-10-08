import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionImeLatch } from '../dashboard/app/utils/session-ime.ts'

function enter(composing = false): KeyboardEvent {
  return { isComposing: composing, keyCode: 13, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent
}

afterEach(() => vi.useRealTimers())

describe('session composer composition', () => {
  it('keeps the final IME Enter from sending until the native grace period ends', () => {
    vi.useFakeTimers()
    const latch = createSessionImeLatch()
    latch.start()
    expect(latch.claim(enter(true))).toBe(false)
    latch.end('中文')
    const finalEnter = enter()
    expect(latch.claim(finalEnter)).toBe(false)
    expect(finalEnter.preventDefault).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(50)
    expect(latch.claim(enter())).toBe(true)
  })

  it('allows Enter after committed Hangul and clears composition on disposal', () => {
    const latch = createSessionImeLatch()
    latch.start()
    latch.end('한')
    expect(latch.claim(enter())).toBe(true)
    latch.start()
    latch.reset()
    expect(latch.claim(enter())).toBe(true)
  })
})
