# Vue Conventions

Framework-agnostic Vue patterns the skill applies regardless of whether the codebase is Nuxt, Vite + Vue, or another shell. The Nuxt-specific application of these patterns lives in [NUXT-APP-CONVENTIONS.md](NUXT-APP-CONVENTIONS.md).

The dominant smell on the Vue side is **logic in components** — `<script setup>` blocks growing into refs + watchers + async + validation + error mapping. Only testable via mount + jsdom. Push logic into composables.

> **Deepening candidates, not rules.** Surface in Explore; grill before adopting. The **module** is the *composable*; "service" is fine as a compound but don't drop "composable".

## 1. Service composables (factory + provide + use)

**Gap.** Heavy logic lives in `<script setup>`: form state, validation, submission, async loaders, derived state, error mapping. The component owns the logic *and* the markup. The only way to test it is to mount it.

**Smell signals.**

- More than ~80 lines in `<script setup>` with multiple `ref`s, `watch`es, and async functions.
- The same `ref` + handler pair duplicated across two or more components in the same feature.
- A child component receives state via prop drilling that the parent only owns because it called an async loader once.
- The component cannot be tested without `mount()` + `flushPromises()` + jsdom.

**Seam.** A **service composable** owns the feature's state and behaviour as a plain factory function. A `provide` wrapper publishes the instance to a subtree; a `use` accessor consumes it. The injection key *is* the seam — tests, storybook, parent overrides all swap the implementation by calling `provide(KEY, fake)` higher up.

The factory is split out so unit tests don't need an `effectScope` or a mounted component. Tests call `createXxxService()` directly and pass IO ports as injected dependencies.

**Template.**

```ts
// composables/useOrderForm.ts
import type { InjectionKey, Ref } from 'vue'
import { inject, provide, ref } from 'vue'

export interface OrderInput { items: { sku: string, qty: number }[] }
export interface Order { id: string }

export interface OrderFormService {
  input: Ref<OrderInput>
  errors: Ref<Record<string, string>>
  submitting: Ref<boolean>
  addItem: (sku: string, qty: number) => void
  removeItem: (sku: string) => void
  submit: () => Promise<Order | null>
}

const KEY: InjectionKey<OrderFormService> = Symbol('OrderFormService')

// Pure factory — no Vue lifecycle, IO injected as a port.
export function createOrderFormService(deps: {
  submit: (input: OrderInput) => Promise<Order>
  initial?: Partial<OrderInput>
}): OrderFormService {
  const input = ref<OrderInput>({ items: [], ...deps.initial })
  const errors = ref<Record<string, string>>({})
  const submitting = ref(false)

  function addItem(sku: string, qty: number) {
    input.value.items.push({ sku, qty })
  }
  function removeItem(sku: string) {
    input.value.items = input.value.items.filter(i => i.sku !== sku)
  }
  async function submit() {
    submitting.value = true
    errors.value = {}
    try {
      return await deps.submit(input.value)
    }
    catch (err: any) {
      errors.value = err?.data?.fieldErrors ?? { _: err?.message ?? 'Failed' }
      return null
    }
    finally {
      submitting.value = false
    }
  }

  return { input, errors, submitting, addItem, removeItem, submit }
}

// Component-facing wrapper. Builds + provides in one call. The `submit` port
// is supplied here; in a Nuxt app it'd be `$fetch(...)`, in a plain Vue app
// it might be axios or a hand-rolled fetch wrapper.
export function provideOrderForm(submit: (input: OrderInput) => Promise<Order>, initial?: Partial<OrderInput>): OrderFormService {
  const service = createOrderFormService({ submit, initial })
  provide(KEY, service)
  return service
}

export function useOrderForm(): OrderFormService {
  const service = inject(KEY)
  if (!service)
    throw new Error('useOrderForm() must be called in a subtree of provideOrderForm()')
  return service
}
```

```vue
<!-- pages/orders/new.vue (or any parent component) -->
<script setup lang="ts">
import { provideOrderForm } from '~/composables/useOrderForm'
const form = provideOrderForm(input => $fetch('/api/orders', { method: 'POST', body: input }))
</script>

<template>
  <OrderItemList />
  <OrderTotals />
  <button :disabled="form.submitting.value" @click="form.submit">Place order</button>
</template>
```

```vue
<!-- components/OrderItemList.vue (anywhere in the subtree) -->
<script setup lang="ts">
const form = useOrderForm() // same instance as the parent
</script>
```

**Test surface (no component mount, no jsdom needed).**

```ts
// composables/useOrderForm.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createOrderFormService } from './useOrderForm'

describe('OrderFormService', () => {
  it('adds and removes items', () => {
    const submit = vi.fn().mockResolvedValue({ id: 'order-1' })
    const form = createOrderFormService({ submit })
    form.addItem('SKU-1', 2)
    form.addItem('SKU-2', 1)
    expect(form.input.value.items).toHaveLength(2)
    form.removeItem('SKU-1')
    expect(form.input.value.items).toEqual([{ sku: 'SKU-2', qty: 1 }])
  })

  it('maps API field errors onto errors ref', async () => {
    const submit = vi.fn().mockRejectedValue({ data: { fieldErrors: { items: 'too few' } } })
    const form = createOrderFormService({ submit })
    form.addItem('SKU-1', 1)
    const result = await form.submit()
    expect(result).toBeNull()
    expect(form.errors.value.items).toBe('too few')
    expect(form.submitting.value).toBe(false)
  })
})
```

IO injected as ports (`deps.submit`); tests pass mocks. **Remote-but-owned** category from DEEPENING.md at the composable level. The factory/provide split keeps `provide()` out of test paths (it throws outside setup).

## 2. Component thinness

A component renders, binds to a service composable's state, and translates events into method calls. It does **not** call `$fetch` directly, implement validation inline, or hold business state in raw `ref`s. When the §1 smells appear, extract a service composable.

**Anti-pattern**: a "container" component that only holds state for a "presentational" one in the same feature. The container should *be* the service composable; the component renders directly from `useXxx()`.

## 3. State scoping (Vue level)

Two scoping options at the Vue layer. Pick the **smallest that works**:

| Scope                             | Mechanism                                              | When                                                                     |
| --------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| **Per-component instance**        | Plain `ref`/`reactive` inside a composable             | Stateless utilities, derived state per-component                         |
| **Per-subtree (shared instance)** | Service composable with `provide`/`inject` (§1)        | Form state, wizard state, feature service multiple components share      |

Pure Vue does not have an SSR-safe app-wide state primitive — for Nuxt's `useState` and the SSR considerations that come with it, see [NUXT-APP-CONVENTIONS.md](NUXT-APP-CONVENTIONS.md) §4.

**Common scope mistakes.**

- A "current user" stored in a per-component `ref` re-fetches on every mount.
- Per-subtree form state stuffed into a module-level singleton leaks across pages — and breaks SSR (state shared between requests on the server).
- A service composable that *should* be subtree-scoped using a module-level `ref` for "convenience": works in dev with one user; fails in any multi-tenant or SSR scenario.

When in doubt, build the service as a factory (§1) and let consumers choose: `provideX()` at a feature root for subtree, `provideX()` at the app root for app-wide, or call the factory directly without `provide` for a per-component instance.

A feature audit: which of §1–§3 is missing? Each gap is a deepening candidate.
