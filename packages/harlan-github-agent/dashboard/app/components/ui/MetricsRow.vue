<script setup lang="ts">
/** Port of nuxtseo design-system UiMetricsRow: the hero KPI strip, hairlines between metrics. */
interface MetricsRowItem {
  /** Preferred: a UiIcon name. Falls back to dotColor if not provided. */
  icon?: string
  /** Text color class applied to the icon. Prefer semantic tokens. */
  iconClass?: string
  /** Legacy dot color class (used when no icon is provided). */
  dotColor?: string
  value: string
  label: string
  trend?: number | null
  trendInverted?: boolean
}

defineProps<{
  items: MetricsRowItem[]
}>()
</script>

<template>
  <div data-testid="metrics-row" class="mb-6 flex flex-wrap items-center gap-3 sm:gap-4">
    <template v-for="(item, i) in items" :key="item.label">
      <div v-if="i > 0" class="hidden w-px self-stretch bg-border sm:block" />
      <div class="flex items-center gap-2 leading-none sm:gap-3">
        <UiIcon
          v-if="item.icon"
          :name="item.icon"
          class="size-4 shrink-0"
          :class="item.iconClass ?? 'text-dimmed'"
          aria-hidden="true"
        />
        <span v-else-if="item.dotColor" class="size-2 shrink-0 rounded-full" :class="item.dotColor" aria-hidden="true" />
        <span class="font-mono text-2xl font-semibold tracking-tight sm:text-4xl">
          {{ item.value }}
        </span>
        <div class="flex flex-col gap-0.5">
          <span class="text-sm text-muted">
            {{ item.label }}
          </span>
          <Transition
            enter-active-class="motion-safe:transition-opacity motion-safe:duration-120"
            enter-from-class="opacity-0"
            enter-to-class="opacity-100"
            leave-active-class="motion-safe:transition-opacity motion-safe:duration-120"
            leave-from-class="opacity-100"
            leave-to-class="opacity-0"
          >
            <UiTrend
              v-if="item.trend != null && item.trend !== 0"
              :value="item.trend"
              :inverted="item.trendInverted"
              colored
              format="percent"
              size="sm"
            />
            <span v-else class="font-mono text-sm text-dimmed" aria-label="No comparison data">—</span>
          </Transition>
        </div>
      </div>
    </template>
  </div>
</template>
