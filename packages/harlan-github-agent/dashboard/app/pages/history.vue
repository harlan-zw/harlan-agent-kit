<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { HistoryRow, OutcomeFilter } from '../utils/history.ts'
import { routineRunPresentation, taskNumber, taskStateDetail, taskSubjectUrl } from '../utils/dashboard.ts'
import {
  canRerunReview,
  historyRangeFromQuery,
  historyRowBadge,
  historyRows,
  historyRowUrl,
  historyRowWork,
  outcomeFilters,
} from '../utils/history.ts'
import HistoryEvidenceSlideover from './_HistoryEvidenceSlideover.vue'

/**
 * What already happened, on what evidence. GitHub style list rows; every row
 * opens the Evidence slideover. Layout and the two local filters live here,
 * the rows are decided in `utils/history.ts`.
 */
const {
  snapshot,
  loading,
  relativeTime,
  duration,
  rerunPending,
  rerunErrors,
  rerunReview,
  itemKey,
} = useDashboard()
const route = useRoute()

const outcomeFilter = ref<OutcomeFilter>('all')
const range = computed(() => historyRangeFromQuery(route.query))

const allRows = computed(() => historyRows(snapshot.value))
const rows = computed(() => historyRows(snapshot.value, outcomeFilter.value, range.value))

/* The slideover reads the live row, so a recorded verdict shows on the next snapshot. */
const selectedKey = ref<string>()
const selected = computed(() => allRows.value.find(row => row.key === selectedKey.value))
const slideoverOpen = computed({
  get: () => selectedKey.value !== undefined,
  set: (value: boolean) => {
    if (!value)
      selectedKey.value = undefined
  },
})

const emptyLine = computed(() => {
  if (allRows.value.length === 0)
    return 'Nothing has finished yet.'
  return outcomeFilter.value === 'all' ? 'Nothing finished in the Stats range.' : 'Nothing matches the filter.'
})

function rowName(row: HistoryRow): string {
  switch (row._tag) {
    case 'Review': return `${row.agent.repository} pull request ${row.agent.pullRequestNumber}`
    case 'Task': return `${row.task.repository} number ${taskNumber(row.task)}`
    case 'Routine': return `${row.run.name} on ${row.run.repository}`
  }
}

function rowDuration(row: HistoryRow): string | undefined {
  switch (row._tag) {
    case 'Review': return duration(row.agent.startedAt, row.agent.completedAt)
    case 'Routine': return duration(row.run.createdAt, row.run.updatedAt)
    case 'Task': return undefined
  }
}

function rowRerunKey(row: HistoryRow): string | undefined {
  return row._tag === 'Review' ? itemKey(row.agent.repository, row.agent.pullRequestNumber, row.agent.revisionId) : undefined
}

function rowRerunError(row: HistoryRow): string | undefined {
  const key = rowRerunKey(row)
  return key === undefined ? undefined : rerunErrors.value[key]
}

function menuItems(row: HistoryRow): DropdownMenuItem[][] {
  const items: DropdownMenuItem[] = [
    { label: 'Open on GitHub', icon: 'i-octicon-link-external-16', to: historyRowUrl(row, snapshot.value), target: '_blank', rel: 'noreferrer' },
  ]
  if (row._tag === 'Review' && canRerunReview(row.agent, snapshot.value)) {
    const { agent } = row
    items.push({
      label: 'Rerun review',
      icon: 'i-octicon-sync-16',
      disabled: rerunPending.value !== undefined,
      onSelect: () => {
        void rerunReview(agent.repository, agent.pullRequestNumber, agent.revisionId)
      },
    })
  }
  return [items]
}

usePageTitle('History')
useHead({
  meta: [{ name: 'description', content: 'Finished reviews, tasks, and Routine runs, newest first.' }],
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
      <div class="min-w-0 flex-1 basis-48">
        <ColumnHeading label="History" :count="rows.length" :level="1" />
      </div>
      <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by outcome">
        <UButton
          v-for="filter in outcomeFilters"
          :key="filter.value"
          size="xs"
          color="neutral"
          :variant="outcomeFilter === filter.value ? 'outline' : 'ghost'"
          :aria-pressed="outcomeFilter === filter.value"
          @click="outcomeFilter = filter.value"
        >
          {{ filter.label }}
        </UButton>
      </div>
    </div>

    <div v-if="range._tag === 'Stats'" class="flex flex-wrap items-center justify-between gap-3 text-sm">
      <span class="text-muted">Showing the Stats range.</span>
      <UButton to="/history" size="xs" color="neutral" variant="outline" icon="i-octicon-x-16">
        Clear
      </UButton>
    </div>

    <div v-if="loading && allRows.length === 0" class="divide-y divide-default border-y border-default" aria-busy="true">
      <div v-for="index in 3" :key="index" class="flex min-h-11 items-center gap-3 px-2 py-2">
        <USkeleton class="h-5 w-16" />
        <USkeleton class="h-5 w-20" />
        <USkeleton class="h-5 flex-1" />
      </div>
    </div>

    <ul v-else-if="rows.length > 0" class="divide-y divide-default border-y border-default" role="list">
      <li v-for="row in rows" :key="row.key" class="relative transition-colors hover:bg-muted">
        <!-- The row is one control. Stretched under the content so links and the menu stay their own. -->
        <button
          type="button"
          class="absolute inset-0 w-full"
          :aria-label="`Evidence for ${rowName(row)}`"
          @click="selectedKey = row.key"
        />
        <div class="pointer-events-none relative flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 px-2 py-2 [&_a]:pointer-events-auto [&_button]:pointer-events-auto">
          <StateBadge
            :tone="historyRowBadge(row).tone"
            :label="historyRowBadge(row).label"
            :confidence="historyRowBadge(row).confidence"
            :uppercase="historyRowBadge(row).uppercase"
          />
          <WorkChip :work="historyRowWork(row)" />

          <div class="order-last w-full min-w-0 sm:order-none sm:w-auto sm:flex-1">
            <EntityIdentity
              v-if="row._tag === 'Review'"
              :author="row.agent.author"
              :title="row.agent.title"
              :url="row.agent.subjectUrl"
              :repository="row.agent.repository"
              kind="pull_request"
              :number="row.agent.pullRequestNumber"
              size="sm"
            />
            <p v-else-if="row._tag === 'Task'" class="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <a :href="taskSubjectUrl(row.task)" target="_blank" rel="noreferrer" class="entity-link shrink-0 font-mono text-sm">{{ row.task.repository }}#{{ taskNumber(row.task) }}</a>
              <span v-if="taskStateDetail(row.task)" class="min-w-0 flex-1 truncate text-sm text-muted">{{ taskStateDetail(row.task) }}</span>
            </p>
            <p v-else class="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span class="text-sm font-medium text-highlighted">{{ row.run.name }}</span>
              <span class="font-mono text-sm text-dimmed">{{ row.run.repository }}</span>
              <span v-if="routineRunPresentation(row.run).detail" class="min-w-0 flex-1 truncate text-sm text-muted">{{ routineRunPresentation(row.run).detail }}</span>
            </p>
          </div>

          <span class="ms-auto flex shrink-0 items-center gap-2">
            <span class="font-mono text-sm text-dimmed">
              <time :datetime="row.at">{{ relativeTime(row.at) }}</time>
              <template v-if="rowDuration(row)"> · {{ rowDuration(row) }}</template>
            </span>
            <UDropdownMenu :items="menuItems(row)" :content="{ align: 'end' }">
              <UButton
                icon="i-octicon-kebab-horizontal-16"
                color="neutral"
                variant="ghost"
                size="xs"
                square
                class="-my-1"
                :aria-label="`More actions for ${rowName(row)}`"
              />
            </UDropdownMenu>
          </span>
        </div>
        <p v-if="rowRerunError(row)" role="alert" class="status-error relative px-2 pb-2 text-sm">
          {{ rowRerunError(row) }}
        </p>
      </li>
    </ul>

    <p v-else class="text-sm text-dimmed">
      {{ emptyLine }}
    </p>

    <HistoryEvidenceSlideover v-model:open="slideoverOpen" :row="selected" />
  </div>
</template>
