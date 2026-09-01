<script setup lang="ts">
import type { AgentRole } from '../../../src/types.ts'
import { useEventListener } from '@vueuse/core'
import { boardColumns, columnEmptyReason, incidentEntries, presentWorkKinds } from '../utils/dashboard.ts'
import { isTypingTarget, overlayOpen } from '../utils/keyboard.ts'
import BoardCard from './_BoardCard.vue'
import BoardColumn from './_BoardColumn.vue'
import BoardIncidentRow from './_BoardIncidentRow.vue'

/**
 * The board. Four fixed columns in the order of the four questions, and one
 * Incident row above them when something failed. Layout and the work kind
 * filter live here; every card decides its own controls.
 */
const { snapshot, loading, relativeTime, setAgentControl, controlPending } = useDashboard()

const workFilter = ref<AgentRole | 'all'>('all')

const columns = computed(() => boardColumns(snapshot.value, workFilter.value))
/** Chips come from the whole board, so choosing one never hides the others. */
const workKinds = computed(() => presentWorkKinds(boardColumns(snapshot.value)))
const incidents = computed(() => incidentEntries(snapshot.value.incidents))
const topIncident = computed(() => incidents.value[0])

const emptyReason = (column: 'needsYou' | 'upNext' | 'running' | 'done') => columnEmptyReason(column, snapshot.value)

function openSystem(): void {
  window.dispatchEvent(new CustomEvent('open-system'))
}

/* Keyboard: j and k walk Needs you, a presses the focused card's one action. */
const focused = ref(-1)
const needsYouCards = ref<Array<InstanceType<typeof BoardCard> | null>>([])

function setNeedsYouCard(index: number, component: unknown): void {
  needsYouCards.value[index] = component as InstanceType<typeof BoardCard> | null
}

function focusCard(index: number): void {
  const count = columns.value.needsYou.length
  if (count === 0)
    return
  const next = Math.min(Math.max(index, 0), count - 1)
  focused.value = next
  needsYouCards.value[next]?.focus()
}

useEventListener('keydown', (event: KeyboardEvent) => {
  if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target) || overlayOpen(document))
    return
  if (event.key === 'j') {
    event.preventDefault()
    focusCard(focused.value + 1)
    return
  }
  if (event.key === 'k') {
    event.preventDefault()
    focusCard(focused.value <= 0 ? 0 : focused.value - 1)
    return
  }
  if (event.key === 'a' && focused.value >= 0) {
    event.preventDefault()
    needsYouCards.value[focused.value]?.pressPrimary()
  }
})

watch(() => columns.value.needsYou.length, (count) => {
  needsYouCards.value.length = count
  if (focused.value > count - 1)
    focused.value = count - 1
})

usePageTitle()
useHead({
  meta: [{ name: 'description', content: 'Live agents, Queue, and GitHub workflow state.' }],
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <h1 class="sr-only">
      Board
    </h1>
    <BoardIncidentRow
      v-if="topIncident"

      :incident="topIncident"
      :age="relativeTime(topIncident.lastSeenAt)"
      :more="incidents.length - 1"
      @open="openSystem"
    />

    <div v-if="workKinds.length > 1" class="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by work">
      <UButton
        size="xs"
        color="neutral"
        :variant="workFilter === 'all' ? 'outline' : 'ghost'"
        :aria-pressed="workFilter === 'all'"
        @click="workFilter = 'all'"
      >
        All
      </UButton>
      <UButton
        v-for="[role, chip] in workKinds"
        :key="role"
        size="xs"
        color="neutral"
        :icon="chip.icon"
        :variant="workFilter === role ? 'outline' : 'ghost'"
        :aria-pressed="workFilter === role"
        @click="workFilter = role"
      >
        {{ chip.label }}
      </UButton>
    </div>

    <div class="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-4">
      <BoardColumn
        id="needs-you"
        label="Needs you"
        :count="columns.needsYou.length"
        :tone="columns.needsYou.length > 0 ? 'warning' : 'default'"
        :accent="columns.needsYou.length > 0"
        :loading="loading"
      >
        <BoardCard
          v-for="(card, index) in columns.needsYou"
          :key="card.key"
          :ref="component => setNeedsYouCard(index, component)"
          :card="card"
          :tabindex="index === Math.max(focused, 0) ? 0 : -1"
        />
        <p v-if="columns.needsYou.length === 0" class="px-1 py-1 text-sm text-dimmed">
          {{ emptyReason('needsYou').text }}
        </p>
      </BoardColumn>

      <BoardColumn id="up-next" label="Up next" :count="columns.queued.length" :loading="loading">
        <BoardCard v-for="card in columns.queued" :key="card.key" :card="card" />
        <div v-if="columns.queued.length === 0" class="flex flex-wrap items-center gap-2 px-1 py-1 text-sm text-dimmed">
          <span>{{ emptyReason('upNext').text }}</span>
          <UButton
            v-if="emptyReason('upNext')._tag === 'Paused'"
            size="xs"
            variant="outline"
            color="neutral"
            icon="i-octicon-play-16"
            :loading="controlPending"
            :disabled="controlPending"
            @click="setAgentControl('resume')"
          >
            Resume
          </UButton>
        </div>
        <template v-if="columns.waiting.length > 0">
          <div class="mt-2">
            <ColumnHeading label="Waiting" :count="columns.waiting.length" />
          </div>
          <BoardCard v-for="card in columns.waiting" :key="card.key" :card="card" />
        </template>
      </BoardColumn>

      <BoardColumn id="running" label="Running" :count="columns.running.length" :loading="loading">
        <BoardCard v-for="card in columns.running" :key="card.key" :card="card" />
        <p v-if="columns.running.length === 0" class="px-1 py-1 text-sm text-dimmed">
          {{ emptyReason('running').text }}
        </p>
      </BoardColumn>

      <BoardColumn id="done" label="Done" :count="columns.doneTotal" :loading="loading">
        <BoardCard v-for="card in columns.done" :key="card.key" :card="card" />
        <p v-if="columns.done.length === 0" class="px-1 py-1 text-sm text-dimmed">
          {{ emptyReason('done').text }}
        </p>
        <NuxtLink v-if="columns.doneTotal > columns.done.length" to="/history" class="entity-link px-1 py-1 text-sm text-muted">
          {{ columns.doneTotal - columns.done.length }} more on History
        </NuxtLink>
      </BoardColumn>
    </div>
  </div>
</template>
