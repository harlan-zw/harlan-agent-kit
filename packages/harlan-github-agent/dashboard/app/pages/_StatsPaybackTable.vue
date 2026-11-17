<script setup lang="ts">
import type { PaybackReport } from '../../../src/payback.ts'
import { paybackRatesText, paybackRows } from '../utils/payback.ts'

/** What each kind of work cost against what it produced. The verdict recommends; Harlan decides. */
const { report } = defineProps<{
  report: PaybackReport
}>()

const rows = computed(() => paybackRows(report))
const ratesText = computed(() => paybackRatesText(report))
</script>

<template>
  <section class="min-w-0" aria-labelledby="stats-payback-heading">
    <UiSectionHeader id="stats-payback-heading" title="Payback" :tooltip="ratesText" />
    <UiTableShell label="Cost and useful outcomes per kind of work" size="sm" row-hover table-class="min-w-3xl">
      <template #head>
        <UiTableTh>Work</UiTableTh>
        <UiTableTh numeric>
          Agent turns
        </UiTableTh>
        <UiTableTh numeric>
          Cost
        </UiTableTh>
        <UiTableTh numeric>
          Merged
        </UiTableTh>
        <UiTableTh numeric>
          Wasted turns
        </UiTableTh>
        <UiTableTh numeric>
          Per merge
        </UiTableTh>
        <UiTableTh>Verdict</UiTableTh>
      </template>
      <tr v-for="row in rows" :key="row.key">
        <UiTableTd row-header size="sm">
          <span class="flex items-baseline gap-2 whitespace-nowrap">
            <WorkChip :work="row.work" />
            <span v-if="row.routine" class="text-sm font-medium text-highlighted">{{ row.routine }}</span>
          </span>
        </UiTableTd>
        <UiTableTd numeric size="sm">
          <UiTableMetricCell :value="row.agentTurns" />
        </UiTableTd>
        <UiTableTd numeric size="sm">
          <span class="whitespace-nowrap font-mono text-sm">{{ row.cost }}</span>
        </UiTableTd>
        <UiTableTd numeric size="sm">
          <span class="whitespace-nowrap text-sm">{{ row.useful }}</span>
        </UiTableTd>
        <UiTableTd numeric size="sm">
          <span class="font-mono text-sm text-muted">{{ row.wasted }}</span>
        </UiTableTd>
        <UiTableTd numeric size="sm">
          <span class="whitespace-nowrap font-mono text-sm text-muted">{{ row.perUseful }}</span>
        </UiTableTd>
        <UiTableTd size="sm">
          <span class="flex flex-col gap-0.5">
            <UiStatusBadge v-if="row.verdict" :status="row.verdictTone" :label="row.verdict" />
            <span v-if="row.reason" class="whitespace-normal text-xs text-muted">{{ row.reason }}</span>
          </span>
        </UiTableTd>
      </tr>
    </UiTableShell>
  </section>
</template>
