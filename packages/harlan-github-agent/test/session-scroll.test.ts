import { describe, expect, it } from 'vitest'
import { createSessionDisclosures } from '../dashboard/app/utils/session-disclosure.ts'
import { sessionCanFollow, sessionFollowOnScroll } from '../dashboard/app/utils/session-scroll.ts'

describe('kiroCrew follow policy adaptation', () => {
  it('does not let resize steal the viewport before the reader scroll event runs', () => {
    expect(sessionCanFollow({ geometry: { scrollTop: 200, scrollHeight: 1300, clientHeight: 400 }, lastWriteTop: 600, following: true })).toBe(false)
  })
  it('keeps follow for a programmatic scroll and releases it for an upward reader scroll', () => {
    expect(sessionFollowOnScroll({ geometry: { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }, lastWriteTop: 600, previousTop: 0, following: true })).toBe(true)
    expect(sessionFollowOnScroll({ geometry: { scrollTop: 598, scrollHeight: 1000, clientHeight: 400 }, lastWriteTop: -1, previousTop: 600, following: true })).toBe(false)
  })
  it('resumes following when the reader explicitly reaches the latest message', () => {
    expect(sessionFollowOnScroll({ geometry: { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }, lastWriteTop: -1, previousTop: 400, following: false })).toBe(true)
  })
  it('keeps explicit disclosure choices until the session changes', () => {
    const store = createSessionDisclosures()
    store.set('command', false)
    expect(store.get('command', true)).toBe(false)
    store.reset()
    expect(store.get('command', true)).toBe(true)
  })
})
