<script setup lang="ts">
import type { HistoryRow } from '../utils/history.ts'
import { routineRunPresentation } from '../utils/dashboard.ts'
import { recentRoutineRuns, routineRows, routineRunDetail } from '../utils/routines.ts'

/**
 * What is coming on the clock. The schedule table answers "when is the next
 * check", soonest first; the log below answers "what did the last ones find".
 */
const { snapshot, loading, now, relativeTime } = useDashboard()

const minute = computed(() => Math.floor(now.value.getTime() / 60_000))
const rows = computed(() => routineRows(snapshot.value.routines, snapshot.value.routineRuns, new Date(minute.value * 60_000)))
const runs = computed(() => recentRoutineRuns(snapshot.value.routineRuns))
const selectedRunId = ref<string>()
const evidenceOpen = ref(false)
const selectedRun = computed<HistoryRow | undefined>(() => {
  const run = snapshot.value.routineRuns.find(run => run.id === selectedRunId.value)
  return run === undefined ? undefined : { _tag: 'Routine', key: run.id, at: run.updatedAt, run }
})

function showRun(id: string): void {
  selectedRunId.value = id
  evidenceOpen.value = true
}

const absolute = new Intl.DateTimeFormat('en', { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
function at(iso: string): string {
  return absolute.format(new Date(iso))
}

usePageTitle('Routines')
useHead({
  meta: [{ name: 'description', content: 'Scheduled checks, soonest first, and what the last runs found.' }],
})
</script>

<template>
  <div class="flex flex-col gap-10">
    <h1 class="sr-only">
      Routines
    </h1>

    <section class="min-w-0" aria-label="Upcoming">
      <UiSectionHeader title="Upcoming">
        <template #after-title>
          <span class="font-mono text-sm font-normal text-muted">{{ rows.length }}</span>
        </template>
      </UiSectionHeader>

      <div v-if="loading" class="flex flex-col gap-px" aria-busy="true">
        <USkeleton v-for="row in 3" :key="row" class="h-10 rounded-sm" />
      </div>

      <UiTableShell v-else-if="rows.length > 0" label="Routines, soonest first" size="sm" row-hover>
        <template #head>
          <UiTableTh>Routine</UiTableTh>
          <UiTableTh>Repository</UiTableTh>
          <UiTableTh visible-from="md">
            Schedule
          </UiTableTh>
          <UiTableTh>Next</UiTableTh>
          <UiTableTh>Last run</UiTableTh>
        </template>
        <tr v-for="row in rows" :key="row.routine.id">
          <UiTableTd row-header size="sm">
            <span class="font-medium text-highlighted">{{ row.routine.name }}</span>
            <span v-if="!row.routine.enabled" class="ms-2 text-sm text-dimmed">Disabled</span>
          </UiTableTd>
          <UiTableTd size="sm">
            <a v-if="row.trackingUrl" :href="row.trackingUrl" target="_blank" rel="noreferrer" class="entity-link text-sm text-muted"><RepositoryIdentity :repository="row.routine.repository"><span class="text-dimmed"> #{{ row.routine.trackingIssueNumber }}</span></RepositoryIdentity></a>
            <a v-else :href="`https://github.com/${row.routine.repository}`" target="_blank" rel="noreferrer" class="entity-link text-sm text-muted"><RepositoryIdentity :repository="row.routine.repository" /></a>
          </UiTableTd>
          <UiTableTd size="sm" visible-from="md">
            <span class="text-sm text-muted">{{ row.schedule }}</span>
          </UiTableTd>
          <UiTableTd size="sm">
            <span v-if="row.next" class="whitespace-nowrap text-sm">
              <span class="text-highlighted">{{ relativeTime(row.next) }}</span>
              <span class="ms-2 font-mono text-dimmed">{{ at(row.next) }}</span>
            </span>
            <span v-else class="text-sm text-dimmed">Not scheduled</span>
          </UiTableTd>
          <UiTableTd size="sm">
            <span class="flex items-center gap-2 whitespace-nowrap">
              <StateBadge :tone="row.tone" :label="row.label" />
              <span v-if="row.routine.lastRunAt" class="font-mono text-sm text-dimmed">{{ relativeTime(row.routine.lastRunAt) }}</span>
            </span>
          </UiTableTd>
        </tr>
      </UiTableShell>

      <UiEmptyState v-else compact icon="calendar" title="No Routines" description="No repository declares a Routine yet." />
    </section>

    <section v-if="runs.length > 0" class="min-w-0" aria-label="Recent runs">
      <UiSectionHeader title="Recent runs">
        <template #after-title>
          <span class="font-mono text-sm font-normal text-muted">{{ runs.length }}</span>
        </template>
      </UiSectionHeader>
      <ul class="divide-y divide-default border-y border-default" role="list">
        <li v-for="run in runs" :key="run.id">
          <button
            type="button"
            class="flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2 text-start transition-colors hover:bg-muted"
            :aria-label="`Open ${run.name} on ${run.repository}, ${at(run.scheduledFor)}`"
            aria-haspopup="dialog"
            @click="showRun(run.id)"
          >
            <span class="w-32 shrink-0">
              <StateBadge :tone="routineRunPresentation(run).tone === 'primary' ? 'neutral' : routineRunPresentation(run).tone" :label="routineRunPresentation(run).label" />
            </span>
            <span class="font-medium text-highlighted">{{ run.name }}</span>
            <RepositoryIdentity :repository="run.repository" class="text-sm text-muted" />
            <span v-if="routineRunDetail(run)" class="min-w-0 flex-1 truncate text-sm text-muted">{{ routineRunDetail(run) }}</span>
            <span class="ms-auto shrink-0 font-mono text-sm text-dimmed"><time :datetime="run.scheduledFor">{{ relativeTime(run.scheduledFor) }}</time></span>
            <UIcon name="i-octicon-chevron-right-16" class="size-4 shrink-0 text-dimmed" aria-hidden="true" />
          </button>
        </li>
      </ul>
    </section>
    <HistoryEvidenceSlideover v-model:open="evidenceOpen" :row="selectedRun" />
  </div>
</template>
