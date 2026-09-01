/**
 * Shared keyboard guards for page shortcuts. Pure: they read only the shape
 * they need, so tests can pass element-like objects.
 */
interface ElementLike {
  tagName?: unknown
  isContentEditable?: unknown
}

/** True when the key press belongs to a text field, so a shortcut must not steal it. */
export function isTypingTarget(target: EventTarget | ElementLike | null): boolean {
  if (target === null || typeof target !== 'object')
    return false
  const element = target as ElementLike
  if (element.isContentEditable === true)
    return true
  return typeof element.tagName === 'string' && /^(?:input|textarea|select)$/i.test(element.tagName)
}

interface QueryRoot {
  querySelector: (selector: string) => unknown
}

/** An open modal, slideover, or menu owns the keyboard. Pass `document`. */
export function overlayOpen(root: QueryRoot): boolean {
  return root.querySelector('[role="dialog"], [role="menu"]') !== null
}
