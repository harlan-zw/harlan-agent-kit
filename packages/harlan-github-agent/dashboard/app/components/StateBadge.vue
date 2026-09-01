<script setup lang="ts">
/**
 * One outcome or state, outlined. Uppercase only for Review outcomes.
 *
 * Confidence is out of 100 and only READY carries one.
 */
const { tone, label, confidence, uppercase = false } = defineProps<{
  tone: 'success' | 'warning' | 'error' | 'neutral'
  label: string
  confidence?: number
  uppercase?: boolean
}>()
</script>

<template>
  <UBadge variant="outline" :color="tone" class="shrink-0 whitespace-nowrap" :class="uppercase ? 'uppercase tracking-wide' : undefined">
    {{ label }}<span v-if="confidence !== undefined" class="font-mono font-normal text-dimmed normal-case"> · {{ confidence }}/100</span>
  </UBadge>
</template>
