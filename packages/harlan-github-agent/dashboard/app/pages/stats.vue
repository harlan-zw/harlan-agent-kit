<script setup lang="ts">
import type { StatsSnapshot } from '../../../src/stats.ts'
import { statusClass } from '../utils/dashboard.ts'
import { statsDateRange, statsRequestRange } from '../utils/stats.ts'
import StatsDailyChart from './_StatsDailyChart.vue'
import StatsOutcomeChart from './_StatsOutcomeChart.vue'
import StatsWorkTable from './_StatsWorkTable.vue'

const route = useRoute()
const router = useRouter()
const from = ref('')
const to = ref('')
const timeZone = ref('UTC')
const snapshot = ref<StatsSnapshot>()
const pending = ref(false)
const rangeMessage = ref<string>()
const loadMessage = ref<string>()
const mounted = ref(false)

const presets = [7, 30, 90] as const

const activePreset = computed(() => presets.find((days) => {
  const range = statsDateRange(days, new Date())
  return range.from === from.value && range.to === to.value
}))

const hasResults = computed(() => snapshot.value !== undefined && (
  Object.values(snapshot.value.summary).some(value => value.value > 0)
  || snapshot.value.work.some(entry => entry.runs > 0)
))

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
    loadMessage.value = cause instanceof Error ? cause.message : 'Stats did not load. Retry.'
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
  from.value = nextFrom
  to.value = nextTo
  const nextQuery = { ...route.query, from: nextFrom, to: nextTo }
  if (route.query.from === nextFrom && route.query.to === nextTo)
    await loadStats()
  else
    await router.push({ path: '/stats', query: nextQuery })
}

async function applyRange(): Promise<void> {
  await setRouteRange(from.value, to.value)
}

async function choosePreset(days: typeof presets[number]): Promise<void> {
  const range = statsDateRange(days, new Date())
  await setRouteRange(range.from, range.to)
}

onMounted(async () => {
  timeZone.value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const routeFrom = queryDate(route.query.from)
  const routeTo = queryDate(route.query.to)
  if (routeFrom === undefined || routeTo === undefined) {
    const range = statsDateRange(30, new Date())
    from.value = range.from
    to.value = range.to
    await router.replace({ path: '/stats', query: { ...route.query, ...range } })
  }
  else {
    from.value = routeFrom
    to.value = routeTo
  }
  await loadStats()
  mounted.value = true
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

useHead({
  title: 'Stats · Harlan GitHub Agent',
  meta: [{ name: 'description', content: 'Completed agent work and outcomes for one date range.' }],
})
</script>

<template>
  <div>
    <header class="grid gap-5 border-b border-default pb-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
      <div>
        <h1 class="text-3xl font-semibold tracking-tight">
          Stats
        </h1>
        <p v-if="snapshot" class="mt-2 text-sm text-muted">
          <span class="font-mono text-2xl font-medium text-default">{{ snapshot.summary.changedPullRequests.value }}</span>
          pull request{{ snapshot.summary.changedPullRequests.value === 1 ? '' : 's' }} changed in this period.
        </p>
        <p v-else class="mt-2 text-sm text-muted">
          Completed work and outcomes from the Journal.
        </p>
      </div>

      <form class="flex min-w-0 flex-wrap items-end gap-2" @submit.prevent="applyRange">
        <label class="grid gap-1 text-sm text-dimmed sm:text-xs" for="stats-from">
          From
          <UInput id="stats-from" v-model="from" type="date" required />
        </label>
        <label class="grid gap-1 text-sm text-dimmed sm:text-xs" for="stats-to">
          To
          <UInput id="stats-to" v-model="to" type="date" required />
        </label>
        <div class="flex items-center gap-1" aria-label="Date range presets">
          <UButton
            v-for="days in presets"
            :key="days"
            type="button"
            size="md"
            :color="activePreset === days ? 'primary' : 'neutral'"
            :variant="activePreset === days ? 'soft' : 'ghost'"
            :class="activePreset === days ? statusClass('primary') : undefined"
            :aria-pressed="activePreset === days"
            @click="choosePreset(days)"
          >
            {{ days }} days
          </UButton>
        </div>
        <UButton type="submit" color="neutral" variant="soft" :loading="pending">
          Apply
        </UButton>
      </form>
    </header>

    <p v-if="rangeMessage" class="mt-4 status-error text-sm" role="alert">
      {{ rangeMessage }}
    </p>
    <div v-if="loadMessage" class="mt-4 flex flex-wrap items-center gap-3 text-sm" role="alert">
      <span class="status-error">{{ loadMessage }}</span>
      <UButton size="sm" color="error" variant="soft" @click="loadStats">
        Retry
      </UButton>
    </div>

    <div v-if="pending && !snapshot" class="grid gap-8 py-10" role="status" aria-label="Loading Stats">
      <USkeleton class="h-44 w-full" />
      <USkeleton class="h-56 w-full" />
    </div>

    <template v-else-if="snapshot">
      <div v-if="snapshot.coverage.pullRequestTriage._tag === 'Partial'" class="mt-6 border-l-2 border-warning pl-4 text-sm status-warning" role="status">
        Pull request triage recording started {{ new Date(snapshot.coverage.pullRequestTriage.startedAt).toLocaleDateString() }}. Earlier totals omit that work.
      </div>

      <div v-if="hasResults" class="grid min-w-0 gap-10 py-8">
        <div class="grid min-w-0 gap-10 xl:grid-cols-2">
          <StatsOutcomeChart :summary="snapshot.summary" />
          <StatsDailyChart :days="snapshot.days" />
        </div>
        <StatsWorkTable :work="snapshot.work" :from="from" :to="to" />
      </div>

      <div v-else class="py-16 text-center">
        <UIcon name="i-lucide-chart-no-axes-column" class="mx-auto size-6 text-dimmed" aria-hidden="true" />
        <p class="mt-3 text-sm text-muted">
          No completed work exists in this date range.
        </p>
        <UButton class="mt-4" color="neutral" variant="ghost" @click="choosePreset(90)">
          Show 90 days
        </UButton>
      </div>
    </template>
  </div>
</template>
