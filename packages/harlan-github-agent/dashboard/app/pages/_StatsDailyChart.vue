<script setup lang="ts">
import type { StatsDay } from '../../../src/stats.ts'

const props = defineProps<{ days: StatsDay[] }>()

const values = computed(() => props.days.map(day => ({
  ...day,
  total: day.fixCommits + day.conflictResolutions + day.openedPullRequests + day.reviewFindings,
})))
const maximum = computed(() => Math.max(1, ...values.value.map(day => day.total)))

function height(value: number): string {
  return `${value === 0 ? 0 : Math.max(3, value / maximum.value * 100)}%`
}

function dayLabel(date: string): string {
  return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00.000Z`))
}
</script>

<template>
  <figure class="min-w-0" aria-labelledby="stats-daily-heading">
    <figcaption id="stats-daily-heading" class="zone-header">
      <span class="text-sm font-medium uppercase tracking-wide text-dimmed sm:text-xs">Daily output</span>
      <hr class="zone-rule">
    </figcaption>
    <div class="mt-4 max-w-full overflow-x-auto pb-2" role="region" tabindex="0" aria-label="Daily output chart. Scroll horizontally to see every day.">
      <div class="grid h-48 min-w-[42rem] items-end gap-1 border-b border-default" :style="{ gridTemplateColumns: `repeat(${Math.max(days.length, 1)}, minmax(0, 1fr))` }">
        <div v-for="day in values" :key="day.date" class="group relative flex h-full min-w-0 items-end" :title="`${dayLabel(day.date)}: ${day.fixCommits} repair commits, ${day.conflictResolutions} conflicts resolved, ${day.openedPullRequests} pull requests opened, ${day.reviewFindings} review issues found`">
          <div class="w-full bg-primary/75 transition-opacity group-hover:bg-primary" :style="{ height: height(day.total) }" />
          <span v-if="day.total > 0" class="absolute inset-x-0 text-center font-mono text-sm text-muted" :style="{ bottom: `calc(${height(day.total)} + 0.25rem)` }">{{ day.total }}</span>
        </div>
      </div>
      <div class="mt-2 flex min-w-[42rem] justify-between font-mono text-sm text-dimmed sm:text-xs">
        <span>{{ days[0] ? dayLabel(days[0].date) : '' }}</span>
        <span>{{ days.at(-1) ? dayLabel(days.at(-1)!.date) : '' }}</span>
      </div>
    </div>
    <p class="mt-2 text-sm text-dimmed sm:text-xs">
      Daily total of repair commits, resolved conflicts, opened pull requests, and Review issues found.
    </p>
  </figure>
</template>
