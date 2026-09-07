<script setup lang="ts">
/**
 * A name and a count. A board column adds a state dot; a page section adds a
 * hairline. Never a title: the tab already named the page.
 */
const { label, count, tone = 'default', live = false, rule = false, level = 2 } = defineProps<{
  label: string
  count?: number
  /** Colours the dot in front of the name. Default draws no dot. */
  tone?: 'default' | 'warning' | 'success' | 'error'
  /** Pulses the dot while agents run. */
  live?: boolean
  /** The hairline after the count. Page sections carry it, board columns do not. */
  rule?: boolean
  level?: 1 | 2
}>()
</script>

<template>
  <div class="flex min-h-6 items-center gap-2">
    <LiveDot v-if="tone !== 'default'" :tone="tone" :live="live" />
    <component :is="`h${level}`" class="text-sm font-medium text-highlighted">
      {{ label }}
    </component>
    <span v-if="count !== undefined" class="font-mono text-sm text-muted">{{ count }}</span>
    <span v-if="rule" class="h-px flex-1 bg-border" aria-hidden="true" />
  </div>
</template>
