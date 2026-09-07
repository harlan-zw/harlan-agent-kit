<script setup lang="ts">
import type { UiIcon as UiIconName } from '../../utils/ui-icons.ts'

/**
 * UiEmptyState — compact (inline, for cards and lists) or full (centered page
 * level). The nuxtseo entrance motion and atmosphere backdrop are dropped:
 * nothing enters with motion in this dashboard.
 */
const {
  compact,
  headingTag = 'h3',
} = defineProps<{
  icon: UiIconName
  title: string
  description?: string
  compact?: boolean
  headingTag?: 'h1' | 'h2' | 'h3'
}>()
</script>

<template>
  <div
    data-ui="UiEmptyState"
    data-testid="empty-state"
    :class="compact
      ? 'flex h-[220px] flex-col items-center justify-center rounded-lg border border-dashed border-default bg-muted'
      : 'flex min-h-[400px] flex-col items-center justify-center py-16 text-center'"
  >
    <!-- Compact: inline empty state for cards/lists -->
    <template v-if="compact">
      <UiIcon :name="icon" class="mb-2 size-8 text-dimmed" aria-hidden="true" />
      <p class="text-sm font-medium text-default">
        {{ title }}
      </p>
      <p v-if="description" class="mt-1 max-w-sm px-4 text-center text-sm text-muted">
        {{ description }}
      </p>
      <div v-if="$slots.default" class="mt-3">
        <slot />
      </div>
    </template>

    <!-- Full: centered page-level empty state -->
    <template v-else>
      <div class="mb-4 inline-flex size-14 items-center justify-center rounded-lg border border-default bg-elevated">
        <UiIcon :name="icon" class="size-7 text-muted" aria-hidden="true" />
      </div>
      <component :is="headingTag" class="mb-1 text-lg font-medium text-default">
        {{ title }}
      </component>
      <p v-if="description" class="mx-auto max-w-md text-sm leading-relaxed text-muted">
        {{ description }}
      </p>
      <div class="mt-6">
        <slot />
      </div>
      <slot name="footer" />
    </template>
  </div>
</template>
