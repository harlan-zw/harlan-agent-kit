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
    <UiSectionHeader id="stats-work-heading" title="Work" />
    <UiTableShell label="Runs and results per kind of work" size="sm" row-hover table-class="min-w-3xl">
      <template #head>
        <UiTableTh>Work</UiTableTh>
        <UiTableTh numeric>
          Runs
        </UiTableTh>
        <UiTableTh>Results</UiTableTh>
        <UiTableTh numeric>
          Median time
        </UiTableTh>
        <UiTableTh align="right">
          <span class="sr-only">Evidence</span>
        </UiTableTh>
      </template>
      <tr v-for="entry in work" :key="workKey(entry)">
        <UiTableTd row-header size="sm">
          <WorkChip :work="workRole(entry)" />
        </UiTableTd>
        <UiTableTd numeric size="sm">
          <UiTableMetricCell :value="entry.runs">
            <template #after>
              <span class="h-1 w-16 rounded-sm bg-muted" aria-hidden="true">
                <span class="block h-full rounded-sm bg-inverted" :style="{ width: barWidth(entry.runs, maximumRuns) }" />
              </span>
            </template>
          </UiTableMetricCell>
        </UiTableTd>
        <UiTableTd size="sm">
          <span class="whitespace-normal text-sm text-muted">{{ workResultText(entry) }}</span>
        </UiTableTd>
        <UiTableTd numeric size="sm">
          <UiTableMetricCell :value="entry.medianDurationMs" :display="medianText(entry.medianDurationMs)" muted />
        </UiTableTd>
        <UiTableTd align="right" size="sm">
          <UButton :to="{ path: '/history', query: historyQuery(entry, { from, to }) }" size="xs" color="neutral" variant="ghost" trailing-icon="i-octicon-arrow-right-16">
            Evidence
          </UButton>
        </UiTableTd>
      </tr>
    </UiTableShell>
  </section>
</template>
