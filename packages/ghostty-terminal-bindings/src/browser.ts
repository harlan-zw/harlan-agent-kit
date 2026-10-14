import type { KeyEvent } from '../.generated/ghostty-web.js'
import { browserKeyMap, Key, KeyAction, Mods } from '../.generated/browser.js'

export { CanvasRenderer, Key, KeyAction, Mods } from '../.generated/browser.js'
export type { GhosttyCell, IRenderable, KeyEvent } from '../.generated/ghostty-web.js'

export type BrowserKeyboardEvent = Pick<
  KeyboardEvent,
  | 'code'
  | 'key'
  | 'type'
  | 'repeat'
  | 'isComposing'
  | 'shiftKey'
  | 'ctrlKey'
  | 'altKey'
  | 'metaKey'
  | 'getModifierState'
>

const modifierKeys: Readonly<Record<string, Key>> = {
  ShiftLeft: Key.SHIFT_LEFT,
  ShiftRight: Key.SHIFT_RIGHT,
  ControlLeft: Key.CONTROL_LEFT,
  ControlRight: Key.CONTROL_RIGHT,
  AltLeft: Key.ALT_LEFT,
  AltRight: Key.ALT_RIGHT,
  MetaLeft: Key.META_LEFT,
  MetaRight: Key.META_RIGHT,
}

/** Produce an event for host encoding. Paste and composition commits use separate operations. */
export function browserKeyEvent(event: BrowserKeyboardEvent, layout?: ReadonlyMap<string, string>): KeyEvent | null {
  if (event.isComposing || event.key === 'Dead' || event.key === 'Process') return null
  const codepoints = Array.from(event.key)
  const printable = codepoints.length === 1
  const key = browserKeyMap[event.code] ?? modifierKeys[event.code] ?? (printable ? Key.UNIDENTIFIED : undefined)
  if (key === undefined) return null
  const altGraph = event.getModifierState('AltGraph')
  const mods =
    (event.shiftKey ? Mods.SHIFT : 0) |
    (event.ctrlKey ? Mods.CTRL : 0) |
    (event.altKey ? Mods.ALT : 0) |
    (event.metaKey ? Mods.SUPER : 0) |
    (event.getModifierState('CapsLock') ? Mods.CAPSLOCK : 0) |
    (event.getModifierState('NumLock') ? Mods.NUMLOCK : 0)
  const consumedMods = printable ? (event.shiftKey ? Mods.SHIFT : 0) | (altGraph ? Mods.CTRL | Mods.ALT : 0) : Mods.NONE
  const utf8 = printable ? event.key : undefined
  const unshifted = printable ? (layout?.get(event.code) ?? event.key.toLowerCase()).codePointAt(0) : undefined
  return {
    action: event.type === 'keyup' ? KeyAction.RELEASE : event.repeat ? KeyAction.REPEAT : KeyAction.PRESS,
    key,
    mods,
    consumedMods,
    composing: false,
    ...(utf8 === undefined ? {} : { utf8 }),
    ...(unshifted === undefined ? {} : { unshiftedCodepoint: unshifted }),
  }
}
