<script setup lang="ts">
import type { StatsWork } from '../../../src/stats.ts'
import { barWidth, historyQuery, medianText, workKey, workResultText, workRole } from '../utils/stats.ts'

/** One row per kind of work. Evidence opens History filtered to this range and kind. */
const { work, from, to } = defineProps<{
  work: StatsWork[]
  from: string
  to: string
}>()

const maximumRuns = computed(() => Math.max(...work.map(entry => entry.runs), 0))
</script>

<template>
  <section class="min-w-0" aria-labelledby="stats-work-heading">
    <ColumnHeading id="stats-work-heading" label="Work" />
    <div class="mt-3 max-w-full overflow-x-auto">
      <table class="w-full min-w-[46rem] text-start text-sm" aria-labelledby="stats-work-heading">
        <thead class="border-b border-default">
          <tr>
            <th scope="col" class="field-label px-3 py-2.5 text-start whitespace-nowrap">
              Work
            </th>
            <th scope="col" class="field-label px-3 py-2.5 text-end whitespace-nowrap">
              Runs
            </th>
            <th scope="col" class="field-label px-3 py-2.5 text-start whitespace-nowrap">
              Results
            </th>
            <th scope="col" class="field-label px-3 py-2.5 text-end whitespace-nowrap">
              Time
            </th>
            <th scope="col" class="field-label px-3 py-2.5 text-end whitespace-nowrap">
              Evidence
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr v-for="entry in work" :key="workKey(entry)" class="transition-colors hover:bg-muted">
            <th scope="row" class="px-3 py-3 text-start font-normal whitespace-nowrap">
              <WorkChip :work="workRole(entry)" />
            </th>
            <td class="px-3 py-3 text-end whitespace-nowrap">
              <span class="inline-flex items-center justify-end gap-2">
                <span class="h-1 w-16 bg-muted" aria-hidden="true">
                  <span class="block h-full bg-inverted" :style="{ width: barWidth(entry.runs, maximumRuns) }" />
                </span>
                <span class="font-mono font-medium">{{ entry.runs }}</span>
              </span>
            </td>
            <td class="px-3 py-3 text-muted">
              {{ workResultText(entry) }}
            </td>
            <td class="px-3 py-3 text-end font-mono whitespace-nowrap text-muted">
              {{ medianText(entry.medianDurationMs) }}
            </td>
            <td class="px-3 py-3 text-end whitespace-nowrap">
              <UButton :to="{ path: '/history', query: historyQuery(entry, { from, to }) }" size="xs" color="neutral" variant="ghost" trailing-icon="i-octicon-arrow-right-16">
                Evidence
              </UButton>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
