<script setup lang="ts">
import type { HistoryRow } from '../utils/history.ts'
import { routineRunPresentation } from '../utils/dashboard.ts'
import {
  filterRoutineRows,
  filterRoutineRuns,
  recentRoutineRuns,
  routineQueueBlocks,
  routineRows,
  routineRunDetail,
} from '../utils/routines.ts'
import RoutineRunModal from './_RoutineRunModal.vue'

/**
 * What is coming on the clock. The schedule table answers "when is the next
 * check", soonest first; the log below answers "what did the last ones find".
 */
const { snapshot, loading, controlsUnavailable, now, relativeTime } = useDashboard()
const { show: showSystem } = useSystemPane()
const route = useRoute()
const router = useRouter()
function queryFilter(key: string) {
  return computed({
    get: () => (typeof route.query[key] === 'string' ? (route.query[key] as string) : 'all'),
    set: (value: string) => {
      void router.replace({ query: { ...route.query, [key]: value === 'all' ? undefined : value } })
    },
  })
}
const repositoryFilter = queryFilter('repository')
const routineFilter = queryFilter('routine')
const resultFilter = queryFilter('result')
const filters = computed(() => ({
  repository: repositoryFilter.value,
  routine: routineFilter.value,
  result: resultFilter.value,
}))
const filtered = computed(() => Object.values(filters.value).some((value) => value !== 'all'))
const repositories = computed(() => [
  { label: 'All repositories', value: 'all' },
  ...[...new Set(snapshot.value.routines.map((routine) => routine.repository))]
    .sort()
    .map((value) => ({ label: value, value })),
])
const routineNames = computed(() => [
  { label: 'All Routines', value: 'all' },
  ...[...new Set(snapshot.value.routines.map((routine) => routine.name))]
    .sort()
    .map((value) => ({ label: value, value })),
])
const results = [
  'Clear',
  'Action required',
  'Blocked',
  'Failed',
  'Completed',
  'Queued',
  'Running',
  'Skipped',
  'Superseded',
]
const historyLink = computed(() => ({
  path: '/history',
  query: {
    work: 'routine_scan',
    repository: filters.value.repository === 'all' ? undefined : filters.value.repository,
    routine: filters.value.routine === 'all' ? undefined : filters.value.routine,
  },
}))
function clearFilters(): void {
  void router.replace({ query: {} })
}

const minute = computed(() => Math.floor(now.value.getTime() / 60_000))
const rows = computed(() =>
  filterRoutineRows(
    routineRows(snapshot.value.routines, snapshot.value.routineRuns, new Date(minute.value * 60_000)),
    filters.value,
  ),
)
const matchingRuns = computed(() => filterRoutineRuns(snapshot.value.routineRuns, filters.value))
const runs = computed(() => recentRoutineRuns(matchingRuns.value))
const blocks = computed(() =>
  controlsUnavailable.value ? [] : routineQueueBlocks(snapshot.value, matchingRuns.value, now.value),
)
const attention = computed(() =>
  rows.value
    .filter((row) => row.resultRun && (row.resultTone === 'warning' || row.resultTone === 'error'))
    .sort(
      (left, right) =>
        Number(right.resultLabel === 'Blocked' || right.resultTone === 'error') -
        Number(left.resultLabel === 'Blocked' || left.resultTone === 'error'),
    ),
)
const allAttention = ref(false)
const visibleAttention = computed(() => (allAttention.value ? attention.value : attention.value.slice(0, 6)))
const selectedRunId = ref<string>()
const evidenceOpen = ref(false)
const runOpen = ref(false)
const chosenRoutine = ref<(typeof rows.value)[number]['routine']>()
const selectedRun = computed<HistoryRow | undefined>(() => {
  const run = snapshot.value.routineRuns.find((run) => run.id === selectedRunId.value)
  return run === undefined ? undefined : { _tag: 'Routine', key: run.id, at: run.updatedAt, run }
})

function showRun(id: string): void {
  selectedRunId.value = id
  evidenceOpen.value = true
}

function chooseRun(routine: (typeof rows.value)[number]['routine']): void {
  chosenRoutine.value = routine
  runOpen.value = true
}

const absolute = new Intl.DateTimeFormat('en', {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
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
    <h1 class="sr-only">Routines</h1>

    <div class="flex flex-wrap gap-3" role="group" aria-label="Routine filters">
      <USelect
        v-model="repositoryFilter"
        :items="repositories"
        aria-label="Repository"
        class="min-h-11 w-full sm:w-64"
      />
      <USelect v-model="routineFilter" :items="routineNames" aria-label="Routine" class="min-h-11 w-full sm:w-56" />
      <USelect
        v-model="resultFilter"
        :items="[{ label: 'All results', value: 'all' }, ...results.map((value) => ({ label: value, value }))]"
        aria-label="Result"
        class="min-h-11 w-full sm:w-48"
      />
      <UButton v-if="filtered" color="neutral" variant="outline" class="min-h-11" @click="clearFilters">
        Clear filters
      </UButton>
    </div>

    <section v-if="blocks.length" class="border-y border-default py-4" aria-label="Queued scans" aria-live="polite">
      <UiSectionHeader title="Queued scans">
        <template #actions>
          <UButton color="neutral" variant="outline" class="min-h-11" @click="showSystem()"> System </UButton>
        </template>
      </UiSectionHeader>
      <ul class="space-y-3">
        <li
          v-for="block in blocks"
          :key="`${block.provider}:${block.model}:${block.reason}`"
          class="flex flex-col gap-1"
        >
          <p class="status-warning">{{ block.count }} queued · {{ block.reason }}</p>
          <p class="break-words text-sm text-muted">
            {{ block.provider }} · {{ block.model
            }}<span v-if="block.retryAt"> · retry {{ relativeTime(block.retryAt) }}</span>
          </p>
        </li>
      </ul>
    </section>

    <section v-if="attention.length" aria-label="Action required">
      <UiSectionHeader title="Action required">
        <template #after-title>
          <span class="font-mono text-sm text-muted">{{ attention.length }}</span>
        </template>
        <template v-if="attention.length > 6" #actions>
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            :label="allAttention ? 'Show less' : 'More'"
            @click="allAttention = !allAttention"
          />
        </template>
      </UiSectionHeader>
      <ul class="divide-y divide-default border-y border-default">
        <li v-for="row in visibleAttention" :key="row.routine.id">
          <button
            type="button"
            class="flex min-h-11 w-full flex-wrap items-center gap-3 px-2 py-2 text-start hover:bg-muted"
            aria-haspopup="dialog"
            @click="showRun(row.resultRun!.id)"
          >
            <StateBadge :tone="row.resultTone" :label="row.resultLabel" />
            <RepositoryIdentity :repository="row.routine.repository" />
            <span>{{ row.routine.name }}</span>
            <span class="text-sm text-muted">{{ row.resultDetail }}</span>
            <span v-if="row.latestRun?.id !== row.resultRun?.id" class="text-sm text-muted">{{ row.label }}</span>
          </button>
        </li>
      </ul>
    </section>

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
          <UiTableTh visible-from="md"> Schedule </UiTableTh>
          <UiTableTh>Next</UiTableTh>
          <UiTableTh>Last run</UiTableTh>
          <UiTableTh>Last result</UiTableTh>
          <UiTableTh><span class="sr-only">Actions</span></UiTableTh>
        </template>
        <tr v-for="row in rows" :key="row.routine.id">
          <UiTableTd row-header size="sm">
            <span class="font-medium text-highlighted">{{ row.routine.name }}</span>
            <span v-if="!row.routine.enabled" class="ms-2 text-sm text-dimmed">Disabled</span>
          </UiTableTd>
          <UiTableTd size="sm">
            <a
              v-if="row.trackingUrl"
              :href="row.trackingUrl"
              target="_blank"
              rel="noreferrer"
              class="entity-link text-sm text-muted"
              ><RepositoryIdentity :repository="row.routine.repository"
                ><span class="text-dimmed"> #{{ row.routine.trackingIssueNumber }}</span></RepositoryIdentity
              ></a
            >
            <a
              v-else
              :href="`https://github.com/${row.routine.repository}`"
              target="_blank"
              rel="noreferrer"
              class="entity-link text-sm text-muted"
              ><RepositoryIdentity :repository="row.routine.repository"
            /></a>
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
            <button
              v-if="row.latestRun"
              type="button"
              class="flex min-h-11 items-center gap-2 whitespace-nowrap hover:underline"
              :aria-label="`Open last run of ${row.routine.name} on ${row.routine.repository}`"
              aria-haspopup="dialog"
              @click="showRun(row.latestRun.id)"
            >
              <StateBadge :tone="row.tone" :label="row.label" />
              <time :datetime="row.latestRun.scheduledFor" class="font-mono text-sm text-dimmed">{{
                relativeTime(row.latestRun.scheduledFor)
              }}</time>
            </button>
            <span v-else class="text-sm text-muted">Never run</span>
          </UiTableTd>
          <UiTableTd size="sm">
            <button
              v-if="row.resultRun"
              type="button"
              class="flex min-h-11 items-center gap-2 whitespace-nowrap hover:underline"
              :aria-label="`Open last result of ${row.routine.name} on ${row.routine.repository}`"
              aria-haspopup="dialog"
              @click="showRun(row.resultRun.id)"
            >
              <StateBadge :tone="row.resultTone" :label="row.resultLabel" />
              <time :datetime="row.resultRun.scheduledFor" class="font-mono text-sm text-dimmed">{{
                relativeTime(row.resultRun.scheduledFor)
              }}</time>
            </button>
            <span v-else class="text-sm text-muted">Never run</span>
          </UiTableTd>
          <UiTableTd size="sm">
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              class="min-h-11 whitespace-nowrap"
              :disabled="controlsUnavailable || !row.routine.enabled"
              :aria-label="`Run ${row.routine.name} on ${row.routine.repository} now`"
              @click="chooseRun(row.routine)"
            >
              Run now
            </UButton>
          </UiTableTd>
        </tr>
      </UiTableShell>

      <UiEmptyState
        v-else
        compact
        icon="calendar"
        title="No Routines"
        :description="filtered ? 'No Routines match the filters.' : 'No repository declares a Routine yet.'"
      />
    </section>

    <section v-if="runs.length > 0" class="min-w-0" aria-label="Recent runs">
      <UiSectionHeader title="Recent runs">
        <template #after-title>
          <span class="font-mono text-sm font-normal text-muted">{{ runs.length }}</span>
        </template>
        <template #actions>
          <UButton :to="historyLink" color="neutral" variant="outline" class="min-h-11"> View History </UButton>
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
              <StateBadge
                :tone="routineRunPresentation(run).tone === 'primary' ? 'neutral' : routineRunPresentation(run).tone"
                :label="routineRunPresentation(run).label"
              />
            </span>
            <span class="font-medium text-highlighted">{{ run.name }}</span>
            <RepositoryIdentity :repository="run.repository" class="text-sm text-muted" />
            <span v-if="routineRunDetail(run)" class="min-w-0 flex-1 truncate text-sm text-muted">{{
              routineRunDetail(run)
            }}</span>
            <span class="ms-auto shrink-0 font-mono text-sm text-dimmed"
              ><time :datetime="run.scheduledFor">{{ relativeTime(run.scheduledFor) }}</time></span
            >
            <UIcon name="i-octicon-chevron-right-16" class="size-4 shrink-0 text-dimmed" aria-hidden="true" />
          </button>
        </li>
      </ul>
    </section>
    <UButton v-if="runs.length === 0" :to="historyLink" color="neutral" variant="outline" class="min-h-11 self-start">
      View History
    </UButton>
    <HistoryEvidenceSlideover v-model:open="evidenceOpen" :row="selectedRun" />
    <RoutineRunModal v-model:open="runOpen" :routine="chosenRoutine" @queued="showRun" />
  </div>
</template>
