<script lang="ts" setup>
import type { SlotTextOptions } from '../../utils/slot-text.ts'
import { computed } from 'vue'
/**
 * Port of nuxtseo design-system UiMetricStat: a compact direct-label stat for
 * a chart area — an optional metric icon, the value, an optional unit label,
 * and a trend delta. Labels a chart inline instead of a separate legend.
 */
const {
  icon,
  value,
  label,
  trend,
  trendInverted,
  animatedValue = true,
} = defineProps<{
  /** UiIcon name for the metric. */
  icon?: string
  /** Formatted value (e.g. "16.4K", "94%"). Omit to show only the label + trend. */
  value?: string
  /** Rolls compact numeric values when they change. */
  animatedValue?: boolean | SlotTextOptions
  /** Unit/metric label (e.g. "clicks"). */
  label?: string
  /** Trend delta; rendered as a UiTrend when non-null. */
  trend?: number | null
  /** Invert trend coloring (lower is better). */
  trendInverted?: boolean
}>()

const animatedValueOptions = computed<SlotTextOptions | null>(() => {
  if (!value || animatedValue === false)
    return null

  const compactMetricValue = /^[+\-$€£¥]?\s*[\d,.]+(?:\s?[kmbt])?(?:\.\d+)?%?$/i.test(value)
  if (typeof animatedValue === 'object')
    return animatedValue

  return compactMetricValue && value.length <= 14
    ? { direction: 'up', duration: 300, stagger: 22 }
    : null
})
</script>

<template>
  <span class="inline-flex min-w-0 items-baseline gap-1.5">
    <UiIcon v-if="icon" :name="icon" class="size-3.5 shrink-0 self-center text-dimmed" aria-hidden="true" />
    <span v-if="value" class="font-mono text-sm font-semibold text-default">
      <UiSlotText
        v-if="animatedValueOptions"
        :text="value"
        :options="animatedValueOptions"
      />
      <template v-else>
        {{ value }}
      </template>
    </span>
    <span v-if="label" class="truncate text-sm text-muted" :class="{ 'font-medium text-default': !value }">{{ label }}</span>
    <UiTrend
      v-if="trend != null"
      :value="trend"
      :inverted="trendInverted"
      colored
      format="percent"
      size="2xs"
    />
  </span>
</template>
