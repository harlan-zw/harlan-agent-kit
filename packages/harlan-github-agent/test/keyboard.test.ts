import { describe, expect, it } from 'vitest'
import { isTypingTarget, overlayOpen } from '../dashboard/app/utils/keyboard.ts'

describe('isTypingTarget', () => {
  it('claims form fields and editable regions for typing', () => {
    expect(isTypingTarget({ tagName: 'INPUT', isContentEditable: false })).toBe(true)
    expect(isTypingTarget({ tagName: 'textarea' })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  it('leaves buttons, cards, and empty targets to the shortcut', () => {
    expect(isTypingTarget({ tagName: 'BUTTON', isContentEditable: false })).toBe(false)
    expect(isTypingTarget({ tagName: 'ARTICLE' })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('overlayOpen', () => {
  it('reports an open dialog or menu from the given root', () => {
    expect(overlayOpen({ querySelector: () => ({}) })).toBe(true)
    expect(overlayOpen({ querySelector: () => null })).toBe(false)
  })
})
