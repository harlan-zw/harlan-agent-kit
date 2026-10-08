/**
 * Adapted from KiroCrew rowDisclosure.tsx at 5dbde278a1a62eb212cd117959776a232725b031.
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 * Changes: functional per-session store. Vue owns subscriptions; no React provider or class.
 */
export function createSessionDisclosures(values = new Map<string, boolean>()) {
  return {
    get: (key: string, fallback: boolean): boolean => values.get(key) ?? fallback,
    set: (key: string, value: boolean): void => { values.set(key, value) },
    reset: (): void => { values.clear() },
  }
}
