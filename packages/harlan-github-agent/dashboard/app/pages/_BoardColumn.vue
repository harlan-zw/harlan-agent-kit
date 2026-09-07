<script setup lang="ts">
/**
 * One column surface: a muted step, a heading with its count, and cards.
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
    class="flex min-w-0 flex-col gap-2 rounded-lg bg-muted p-2"
  >
    <!-- The label and count as one string, so no accessible-name algorithm runs them together. -->
    <span :id="`${id}-heading`" class="sr-only">{{ label }}, {{ count }}</span>
    <div class="px-1">
      <ColumnHeading :label="label" :count="count" :tone="tone" :live="live" />
    </div>
    <template v-if="loading">
      <USkeleton class="h-24 rounded-md" />
      <USkeleton class="h-24 rounded-md" />
    </template>
    <slot v-else />
  </section>
</template>
