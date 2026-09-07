<script setup lang="ts">
/**
 * One column surface: a muted step, a heading with its count, and a body that
 * scrolls on its own inside the board height, so the page never scrolls.
 *
 * The region takes its accessible name from the heading wrapper, so the count
 * is part of the name a screen reader announces.
 */
const {
  id,
  label,
  count,
  tone = 'default',
  live = false,
  loading = false,
} = defineProps<{
  id: string
  label: string
  count: number
  /** The dot before the name. Needs you turns amber, Running turns green, only while they hold cards. */
  tone?: 'default' | 'warning' | 'success'
  live?: boolean
  loading?: boolean
}>()
</script>

<template>
  <section
    role="region"
    :aria-labelledby="`${id}-heading`"
    class="flex min-h-0 min-w-0 flex-col rounded-lg bg-muted p-2"
  >
    <!-- The label and count as one string, so no accessible-name algorithm runs them together. -->
    <span :id="`${id}-heading`" class="sr-only">{{ label }}, {{ count }}</span>
    <div class="px-1 pb-1.5">
      <ColumnHeading :label="label" :count="count" :tone="tone" :live="live" />
    </div>
    <div class="flex min-h-0 flex-1 flex-col gap-1.5 md:overflow-y-auto">
      <template v-if="loading">
        <USkeleton class="h-20 shrink-0 rounded-md" />
        <USkeleton class="h-20 shrink-0 rounded-md" />
      </template>
      <slot v-else />
    </div>
  </section>
</template>
