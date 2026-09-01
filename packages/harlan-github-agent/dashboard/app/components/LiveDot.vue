<script setup lang="ts">
/** A state dot. Pulses only while agents run, and holds solid under reduced motion. */
const { tone = 'neutral', live = false, label } = defineProps<{
  tone?: 'success' | 'warning' | 'error' | 'neutral'
  live?: boolean
  label?: string
}>()

const toneClass = {
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
  neutral: 'bg-accented',
}
</script>

<template>
  <span
    class="inline-block size-2 shrink-0 rounded-full"
    :class="[toneClass[tone], live ? 'live-dot' : undefined]"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  />
</template>
