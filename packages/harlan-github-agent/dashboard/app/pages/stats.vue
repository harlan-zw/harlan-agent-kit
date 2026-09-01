<script setup lang="ts">
import type { StatsSnapshot } from '../../../src/stats.ts'
import { activeStatsPreset, coverageText, hasStatsResults, statsDateRange, statsPresets, statsRequestRange } from '../utils/stats.ts'
import StatsDailyChart from './_StatsDailyChart.vue'
import StatsOutcomeChart from './_StatsOutcomeChart.vue'
import StatsWorkTable from './_StatsWorkTable.vue'

/**
 * What the work produced over a range. Two small charts and one table.
 *
 * The URL query is the source of truth for the range: the form writes it,
 * and every change of it refetches. The page never scores or ranks.
 */
const route = useRoute()
const from = ref('')
const to = ref('')
const timeZone = ref('UTC')
const snapshot = ref<StatsSnapshot>()
const pending = ref(false)
const rangeMessage = ref<string>()
const loadMessage = ref<string>()
const mounted = ref(false)
const currentDate = shallowRef<Date>()

const activePreset = computed(() => currentDate.value === undefined
  ? undefined
  : activeStatsPreset({ from: from.value, to: to.value }, currentDate.value))
const hasResults = computed(() => snapshot.value !== undefined && hasStatsResults(snapshot.value))
const coverageLine = computed(() => snapshot.value === undefined ? undefined : coverageText(snapshot.value.coverage.pullRequestTriage))

function queryDate(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

async function loadStats(): Promise<void> {
  rangeMessage.value = undefined
  loadMessage.value = undefined
  const range = statsRequestRange({ from: from.value, to: to.value }, timeZone.value)
  if (range._tag === 'Invalid') {
    rangeMessage.value = range.message
    snapshot.value = undefined
    return
  }
  pending.value = true
  await $fetch<StatsSnapshot>('/api/stats', {
    query: {
      from: range.range.from,
      to: range.range.to,
      time_zone: range.range.timeZone,
    },
  }).then((value) => {
    snapshot.value = value
  }).catch((cause: unknown) => {
    snapshot.value = undefined
    loadMessage.value = cause instanceof Error ? cause.message : 'Stats did not load.'
  }).finally(() => {
    pending.value = false
  })
}

async function setRouteRange(nextFrom: string, nextTo: string): Promise<void> {
  const range = statsRequestRange({ from: nextFrom, to: nextTo }, timeZone.value)
  if (range._tag === 'Invalid') {
    rangeMessage.value = range.message
    return
  }
  rangeMessage.value = undefined
  from.value = nextFrom
  to.value = nextTo
  if (route.query.from === nextFrom && route.query.to === nextTo)
    await loadStats()
  else
    await navigateTo({ path: '/stats', query: { ...route.query, from: nextFrom, to: nextTo } })
}

async function applyRange(): Promise<void> {
  await setRouteRange(from.value, to.value)
}

async function choosePreset(days: number): Promise<void> {
  const range = statsDateRange(days, new Date())
  await setRouteRange(range.from, range.to)
}

async function initializeStats(): Promise<void> {
  timeZone.value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  currentDate.value = new Date()
  const routeFrom = queryDate(route.query.from)
  const routeTo = queryDate(route.query.to)
  if (routeFrom === undefined || routeTo === undefined) {
    const range = statsDateRange(30, currentDate.value)
    from.value = range.from
    to.value = range.to
    await navigateTo({ path: '/stats', query: { ...route.query, ...range }, replace: true })
  }
  else {
    from.value = routeFrom
    to.value = routeTo
  }
  await loadStats()
  mounted.value = true
}

onMounted(() => {
  void initializeStats()
})

watch(() => [route.query.from, route.query.to], async ([nextFrom, nextTo]) => {
  if (!mounted.value)
    return
  const routeFrom = queryDate(nextFrom)
  const routeTo = queryDate(nextTo)
  if (routeFrom === undefined || routeTo === undefined)
    return
  from.value = routeFrom
  to.value = routeTo
  await loadStats()
})

usePageTitle('Stats')
useHead({
  meta: [{ name: 'description', content: 'What the agents produced over one date range.' }],
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <ColumnHeading label="Stats" :level="1" />

    <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <form class="flex flex-wrap items-center gap-2" aria-label="Date range" @submit.prevent="applyRange">
        <label class="flex items-center gap-2">
          <span class="field-label">From</span>
          <UInput v-model="from" type="date" size="md" required class="w-38" />
        </label>
        <label class="flex items-center gap-2">
          <span class="field-label">To</span>
          <UInput v-model="to" type="date" size="md" required class="w-38" />
        </label>

        <div class="flex items-center gap-0.5" role="group" aria-label="Presets">
          <UButton
            v-for="days in statsPresets"
            :key="days"
            type="button"
            size="xs"
            color="neutral"
            :variant="activePreset === days ? 'outline' : 'ghost'"
            :aria-pressed="activePreset === days"
            :aria-label="`${days} days`"
            class="font-mono"
            @click="choosePreset(days)"
          >
            {{ days }}
          </UButton>
        </div>
        <UButton type="submit" color="neutral" variant="outline" size="sm" :loading="pending">
          Apply
        </UButton>
      </form>
    </div>

    <p v-if="rangeMessage" class="status-error text-sm" role="alert">
      {{ rangeMessage }}
    </p>
    <p v-if="loadMessage" class="flex flex-wrap items-center gap-3 text-sm" role="alert">
      <span class="status-error">{{ loadMessage }}</span>
      <UButton size="xs" color="neutral" variant="outline" @click="loadStats">
        Retry
      </UButton>
    </p>
    <p v-if="coverageLine" class="text-sm text-muted" role="status">
      {{ coverageLine }}
    </p>

    <div v-if="pending" class="grid gap-10 md:grid-cols-2" role="status" aria-label="Loading Stats">
      <USkeleton class="h-48 w-full" />
      <USkeleton class="h-48 w-full" />
      <USkeleton class="h-40 w-full md:col-span-2" />
    </div>

    <template v-else-if="snapshot">
      <div v-if="hasResults" class="grid min-w-0 gap-10">
        <div class="grid min-w-0 gap-10 md:grid-cols-2">
          <StatsOutcomeChart :summary="snapshot.summary" />
          <StatsDailyChart :days="snapshot.days" />
        </div>
        <StatsWorkTable :work="snapshot.work" :from="from" :to="to" />
      </div>

      <p v-else class="flex flex-wrap items-center gap-3 text-sm text-muted">
        <span>No completed work exists in this range.</span>
        <UButton size="xs" color="neutral" variant="outline" @click="choosePreset(90)">
          Show 90 days
        </UButton>
      </p>
    </template>
  </div>
</template>
