<script setup lang="ts">
import type { StatsDay } from '../../../src/stats.ts'
import { useElementSize } from '@vueuse/core'
import { barWidth, dayLabel, dayTitle, dayTotal, labelFits } from '../utils/stats.ts'

/**
 * One bar per day, ink on paper. A value sits on its bar when the column is
 * wide enough; otherwise the bar's title carries it. The container scrolls
 * sideways on narrow screens and is focusable, so the keyboard reaches it.
 */
const { days } = defineProps<{ days: StatsDay[] }>()

const grid = ref<HTMLElement | null>(null)
const { width } = useElementSize(grid)

const columns = computed(() => Math.max(days.length, 1))
const totals = computed(() => days.map(day => ({ day, total: dayTotal(day) })))
const maximum = computed(() => Math.max(...totals.value.map(entry => entry.total), 0))
/** Column width minus the 2px gap between bars. */
const columnWidth = computed(() => width.value / columns.value - 2)
const first = computed(() => days[0])
const last = computed(() => days.at(-1))
</script>

<template>
  <section class="min-w-0" aria-labelledby="stats-daily-heading">
    <ColumnHeading id="stats-daily-heading" label="Outcomes per day" />
    <div
      class="mt-3 max-w-full overflow-x-auto pb-1"
      role="region"
      tabindex="0"
      aria-label="Outcomes per day. Scroll sideways to see every day."
    >
      <div
        ref="grid"
        class="grid h-48 items-end gap-0.5 border-b border-default pt-4"
        :style="{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, minWidth: `${columns * 0.75}rem` }"
      >
        <div
          v-for="{ day, total } in totals"
          :key="day.date"
          class="relative flex h-full min-w-0 items-end"
          :title="dayTitle(day)"
        >
          <div class="w-full bg-inverted" :style="{ height: barWidth(total, maximum) }" />
          <span
            v-if="total > 0 && labelFits(total, columnWidth)"
            class="absolute inset-x-0 text-center font-mono text-sm text-muted"
            :style="{ bottom: `calc(${barWidth(total, maximum)} + 0.125rem)` }"
          >{{ total }}</span>
        </div>
      </div>
      <div class="mt-1.5 flex justify-between font-mono text-sm text-dimmed" :style="{ minWidth: `${columns * 0.75}rem` }">
        <span>{{ first ? dayLabel(first.date) : '' }}</span>
        <span>{{ last && last !== first ? dayLabel(last.date) : '' }}</span>
      </div>
    </div>
  </section>
</template>
