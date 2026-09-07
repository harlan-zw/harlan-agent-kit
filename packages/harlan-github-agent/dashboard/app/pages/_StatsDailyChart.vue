<script setup lang="ts">
import type { StatsDay } from '../../../src/stats.ts'
import { useElementSize } from '@vueuse/core'
import { useChartTickPlan } from '../composables/useChartTickPlan.ts'
import { dayLabel, dayTitle, dayTotal } from '../utils/stats.ts'

/**
 * One bar per day on the sparkline primitive, with calendar-aware ticks below.
 * The visible summary is the tick row; the full per-day breakdown is read out
 * to assistive technology.
 */
const { days } = defineProps<{ days: StatsDay[] }>()

const frame = ref<HTMLElement | null>(null)
const { width } = useElementSize(frame)
const totals = computed(() => days.map(dayTotal))
const dates = computed(() => days.map(day => day.date))
const { tickPlan, firstTickYear } = useChartTickPlan({ dates })
const ticks = computed(() => tickPlan.value.indices.map((index, position) => ({
  index,
  left: days.length <= 1 ? 0 : (index / (days.length - 1)) * 100,
  label: tickPlan.value.format(new Date(`${days[index]?.date}T00:00:00.000Z`), position, firstTickYear.value),
})))
const summary = computed(() => days.map(dayTitle).join('. '))
</script>

<template>
  <section class="min-w-0" aria-labelledby="stats-daily-heading">
    <UiSectionHeader id="stats-daily-heading" title="Outcomes per day" :description="days.length > 0 ? `${dayLabel(days[0]!.date)} to ${dayLabel(days.at(-1)!.date)}` : undefined" />
    <figure class="min-w-0">
      <!-- Pixel sizes, so the bar corners stay square instead of stretching with a scaled viewBox. -->
      <div ref="frame" class="h-40 w-full">
        <UiSparkline v-if="width > 0" :data="totals" variant="bars" size="lg" :width="Math.round(width)" :height="160" :colors="['var(--ui-primary)']" />
      </div>
      <div class="relative mt-1.5 h-5 font-mono text-sm text-dimmed" aria-hidden="true">
        <span
          v-for="tick in ticks"
          :key="tick.index"
          class="absolute top-0 whitespace-nowrap"
          :style="{ left: `${tick.left}%`, transform: tick.left === 0 ? 'none' : tick.left >= 99 ? 'translateX(-100%)' : 'translateX(-50%)' }"
        >{{ tick.label }}</span>
      </div>
      <figcaption class="sr-only">
        {{ summary }}
      </figcaption>
    </figure>
  </section>
</template>
