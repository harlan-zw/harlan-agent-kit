/**
 * Adapted from KiroCrew useImeGuard.ts at 5dbde278a1a62eb212cd117959776a232725b031.
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 * Changes: omit React synthetic events; expose native composition state for the Vue composer.
 */
const HANGUL = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]$/

export function createSessionImeLatch() {
  let latched = false
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    start(): void {
      clearTimeout(timer)
      latched = true
    },
    end(data?: string): void {
      clearTimeout(timer)
      if (data && HANGUL.test(data)) {
        latched = false
        return
      }
      latched = true
      timer = setTimeout(() => {
        latched = false
      }, 50)
    },
    reset(): void {
      clearTimeout(timer)
      latched = false
    },
    claim(event: KeyboardEvent): boolean {
      if (!latched && !event.isComposing && event.keyCode !== 229)
        return true
      if (!event.isComposing && event.keyCode !== 229)
        event.preventDefault()
      event.stopPropagation()
      return false
    },
  }
}
