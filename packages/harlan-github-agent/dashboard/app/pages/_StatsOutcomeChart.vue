<script setup lang="ts">
import type { StatsSnapshot } from '../../../src/stats.ts'
import { comparisonText } from '../utils/stats.ts'

const props = defineProps<{ summary: StatsSnapshot['summary'] }>()

const outcomes = computed(() => [
  { label: 'Pull requests changed', comparison: props.summary.changedPullRequests },
  { label: 'Repair commits', comparison: props.summary.fixCommits },
  { label: 'Conflicts resolved', comparison: props.summary.conflictResolutions },
  { label: 'Pull requests opened', comparison: props.summary.openedPullRequests },
  { label: 'Review issues found', comparison: props.summary.reviewFindings },
])

function width(value: number, maximum: number): string {
  return `${maximum === 0 ? 0 : Math.max(2, value / maximum * 100)}%`
}
</script>

<template>
  <figure class="min-w-0" aria-labelledby="stats-outcome-heading">
    <figcaption id="stats-outcome-heading" class="zone-header">
      <span class="text-sm font-medium uppercase tracking-wide text-dimmed sm:text-xs">Outcomes</span>
      <hr class="zone-rule">
    </figcaption>
    <ul class="mt-4 grid gap-4" role="list">
      <li v-for="outcome in outcomes" :key="outcome.label" class="grid gap-1.5 sm:grid-cols-[12rem_minmax(0,1fr)_8rem] sm:items-center sm:gap-4">
        <span class="text-sm">{{ outcome.label }}</span>
        <div class="grid gap-1" aria-hidden="true">
          <div class="h-2 bg-muted">
            <div class="h-full bg-primary" :style="{ width: width(outcome.comparison.value, Math.max(outcome.comparison.value, outcome.comparison.previous)) }" />
          </div>
          <div class="h-1 bg-muted">
            <div class="h-full bg-neutral-400 dark:bg-neutral-600" :style="{ width: width(outcome.comparison.previous, Math.max(outcome.comparison.value, outcome.comparison.previous)) }" />
          </div>
        </div>
        <div class="font-mono text-sm tabular-nums sm:text-right sm:text-xs">
          <span class="text-default">{{ outcome.comparison.value }}</span>
          <span class="text-dimmed"> / {{ outcome.comparison.previous }}</span>
        </div>
        <span class="text-sm text-dimmed sm:col-start-2 sm:col-span-2 sm:text-xs">{{ comparisonText(outcome.comparison) }}</span>
      </li>
    </ul>
    <p class="mt-4 font-mono text-sm text-dimmed sm:text-xs">
      Emerald is this period. Grey is the previous period. Every bar starts at zero.
    </p>
  </figure>
</template>
