<script setup lang="ts">
/**
 * One outcome or state: a dot and a short label, no box. The dot carries the
 * colour so a column of them scans; the label carries the word. Uppercase only
 * for Review outcomes, and confidence trails in mono.
 */
const { tone, label, confidence, uppercase = false } = defineProps<{
  tone: 'success' | 'warning' | 'error' | 'neutral'
  label: string
  confidence?: number
  uppercase?: boolean
}>()

const toneClass = {
  success: 'status-success',
  warning: 'status-warning',
  error: 'status-error',
  neutral: 'text-muted',
}
</script>

<template>
  <span class="inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-medium" :class="[toneClass[tone], uppercase ? 'uppercase tracking-wide' : undefined]">
    <LiveDot :tone="tone" />
    <span>{{ label }}</span>
    <span v-if="confidence !== undefined" class="font-mono font-normal text-dimmed normal-case tracking-normal">{{ confidence }}</span>
  </span>
</template>
