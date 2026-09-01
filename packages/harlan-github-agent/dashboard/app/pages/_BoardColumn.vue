<script setup lang="ts">
/**
 * One column surface: a muted step, a heading with its count, and cards.
 *
 * The region takes its accessible name from the heading wrapper, so the count
 * pill is part of the name a screen reader announces.
 */
const {
  id,
  label,
  count,
  tone = 'default',
  accent = false,
  loading = false,
} = defineProps<{
  id: string
  label: string
  count: number
  tone?: 'default' | 'warning'
  /** The amber hairline. Only Needs you earns it, and only while it holds entries. */
  accent?: boolean
  loading?: boolean
}>()
</script>

<template>
  <section
    role="region"
    :aria-labelledby="`${id}-heading`"
    class="flex min-w-0 flex-col gap-2 rounded-lg bg-muted p-2"
    :class="accent ? 'border-t border-warning' : undefined"
  >
    <!-- The label and count as one string, so no accessible-name algorithm runs them together. -->
    <span :id="`${id}-heading`" class="sr-only">{{ label }}, {{ count }}</span>
    <ColumnHeading :label="label" :count="count" :tone="tone" />
    <template v-if="loading">
      <USkeleton class="h-24 rounded-md" />
      <USkeleton class="h-24 rounded-md" />
    </template>
    <slot v-else />
  </section>
</template>
