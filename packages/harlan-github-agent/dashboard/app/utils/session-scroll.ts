/**
 * Adapted from KiroCrew FollowController.ts at 5dbde278a1a62eb212cd117959776a232725b031.
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 * Changes: retain geometry and self-scroll rules; expose a small Vue-independent follow decision.
 */
export interface SessionScrollGeometry { scrollTop: number, scrollHeight: number, clientHeight: number }

export function sessionBottomTarget(geometry: SessionScrollGeometry): number {
  return Math.max(0, geometry.scrollHeight - geometry.clientHeight)
}

export function sessionDistanceFromBottom(geometry: SessionScrollGeometry): number {
  return geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight
}

export function sessionIsSelfScroll(scrollTop: number, lastWriteTop: number, epsilon = 2): boolean {
  return lastWriteTop >= 0 && Math.abs(scrollTop - lastWriteTop) <= epsilon
}

export function sessionFollowOnScroll(input: { geometry: SessionScrollGeometry, lastWriteTop: number, previousTop: number, following: boolean }): boolean {
  if (sessionIsSelfScroll(input.geometry.scrollTop, input.lastWriteTop))
    return input.following
  if (input.geometry.scrollTop < input.previousTop - 1)
    return false
  return sessionDistanceFromBottom(input.geometry) <= 2 ? true : input.following
}

/** Check live geometry before a resize callback can beat the scroll event. */
export function sessionCanFollow(input: { geometry: SessionScrollGeometry, lastWriteTop: number, following: boolean }): boolean {
  return input.following && input.geometry.clientHeight > 0
    && (input.lastWriteTop < 0 || input.geometry.scrollTop >= input.lastWriteTop - 2)
}
