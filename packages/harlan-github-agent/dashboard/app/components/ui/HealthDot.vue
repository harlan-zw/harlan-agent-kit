<script setup lang="ts">
import type { HealthStatus } from '../../utils/semantic-colors.ts'
import { healthColors } from '../../utils/semantic-colors.ts'

/** UiHealthDot — one dot for a health state. `pulse` reuses the live dot, the one loop this app allows. */
const { health = 'unknown', size = 'sm', pulse = false, label } = defineProps<{
  health?: HealthStatus | null
  size?: 'xs' | 'sm' | 'md'
  pulse?: boolean
  /**
   * Accessible name for the status. Pass when the dot stands alone (no adjacent
   * text), so the color is not the only channel conveying state. Omit when a
   * visible text label sits next to the dot — it stays decorative then.
   */
  label?: string
}>()

const sizeClass = { xs: 'size-1.5', sm: 'size-2', md: 'size-2.5' } as const
</script>

<template>
  <span
    data-ui="UiHealthDot"
    class="shrink-0 rounded-full"
    :class="[
      sizeClass[size],
      healthColors(health).dot,
      pulse && 'live-dot',
    ]"
    :role="label ? 'img' : undefined"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
  />
</template>
