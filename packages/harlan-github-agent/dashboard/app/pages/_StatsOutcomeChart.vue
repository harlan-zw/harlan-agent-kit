<script setup lang="ts">
import type { StatsSnapshot } from '../../../src/stats.ts'
import { barWidth, outcomeRows, outcomeScale } from '../utils/stats.ts'

/**
 * Five outcomes, this period against the previous one. Bars start at zero
 * and every row shares one scale, so length compares across rows.
 */
const { summary } = defineProps<{ summary: StatsSnapshot['summary'] }>()

const rows = computed(() => outcomeRows(summary))
const scale = computed(() => outcomeScale(rows.value))
</script>

<template>
  <section class="min-w-0" aria-labelledby="stats-outcome-heading">
    <ColumnHeading id="stats-outcome-heading" label="Outcomes" />
    <div class="mt-3 grid grid-cols-[minmax(0,1fr)_4rem_4.5rem] items-end gap-x-3 pb-1 text-end">
      <span class="field-label col-start-2">This period</span>
      <span class="field-label">Previous</span>
    </div>
    <ul class="grid divide-y divide-default border-t border-default" role="list">
      <li v-for="row in rows" :key="row.label" class="grid grid-cols-[minmax(0,1fr)_4rem_4.5rem] items-center gap-x-3 py-2.5">
        <div class="grid min-w-0 gap-1.5">
          <span class="truncate text-sm">{{ row.label }}</span>
          <div class="grid gap-1" aria-hidden="true">
            <div class="h-2 bg-inverted" :style="{ width: barWidth(row.comparison.value, scale) }" />
            <div class="h-1 bg-accented" :style="{ width: barWidth(row.comparison.previous, scale) }" />
          </div>
        </div>
        <span class="font-mono text-sm text-end font-medium">{{ row.comparison.value }}</span>
        <span class="font-mono text-sm text-end text-muted">{{ row.comparison.previous }}</span>
        <span class="sr-only">{{ row.text }}</span>
      </li>
    </ul>
  </section>
</template>
