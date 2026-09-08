<script setup lang="ts">
import type { AgentRole } from '../../../src/types.ts'
import { useEventListener } from '@vueuse/core'
import { boardColumns, columnEmptyReason, incidentEntries, presentWorkKinds } from '../utils/dashboard.ts'
import { isTypingTarget, overlayOpen } from '../utils/keyboard.ts'
import BoardCard from './_BoardCard.vue'
import BoardColumn from './_BoardColumn.vue'
import BoardIncidentRow from './_BoardIncidentRow.vue'

/**
 * The board, in the order of the four questions. Needs you is a full-width
 * priority list, because a decision is read as a line; the three columns
 * below hold what is coming, running, and done. The board fills the viewport
 * on desktop and each region scrolls on its own. Layout and the work kind
 * filter live here; every card decides its own controls.
 */
const { snapshot, loading, relativeTime, setAgentControl, controlPending } = useDashboard()

const workFilter = ref<AgentRole | 'all'>('all')

const columns = computed(() => boardColumns(snapshot.value, workFilter.value))
const attentionOwner = ref<'You' | 'Agent'>('You')
const attentionCards = computed(() => attentionOwner.value === 'You' ? columns.value.needsYou : columns.value.agentTasks)
const attentionLabel = computed(() => attentionOwner.value === 'You' ? 'Needs you' : 'Agent tasks')
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
  const count = attentionCards.value.length
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

watch(() => attentionCards.value.length, (count) => {
  needsYouCards.value.length = count
  if (focused.value > count - 1)
    focused.value = count - 1
})

watch(attentionOwner, () => {
  focused.value = -1
})

usePageTitle()
useHead({
  meta: [{ name: 'description', content: 'Live agents, Queue, and GitHub workflow state.' }],
})
</script>

<template>
  <div class="flex flex-col gap-4 md:h-[calc(100dvh-6rem)] xl:h-[calc(100dvh-8rem)]">
    <h1 class="sr-only">
      Board
    </h1>
    <BoardIncidentRow
      v-if="topIncident"
      class="shrink-0"
      :incident="topIncident"
      :age="relativeTime(topIncident.lastSeenAt)"
      :more="incidents.length - 1"
      @open="openSystem"
    />

    <div v-if="workKinds.length > 1" class="flex shrink-0 flex-wrap items-center gap-1" role="group" aria-label="Filter by work">
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

    <!-- Question one. A list, capped at half the board, scrolling on its own. -->
    <section
      role="region"
      aria-labelledby="attention-heading"
      class="flex min-h-0 shrink-0 flex-col md:max-h-[50%]"
    >
      <span id="attention-heading" class="sr-only">{{ attentionLabel }}, {{ attentionCards.length }}</span>
      <div class="flex flex-wrap items-center gap-2 px-2 pb-2" role="group" aria-label="Who acts next">
        <UButton
          color="neutral"
          class="min-h-11 md:min-h-0"
          :variant="attentionOwner === 'You' ? 'outline' : 'ghost'"
          :aria-pressed="attentionOwner === 'You'"
          aria-controls="attention-list"
          @click="attentionOwner = 'You'"
        >
          Needs you <span class="font-mono" :class="columns.needsYou.length > 0 ? 'text-warning' : 'text-dimmed'">{{ columns.needsYou.length }}</span>
        </UButton>
        <UButton
          color="neutral"
          class="min-h-11 md:min-h-0"
          :variant="attentionOwner === 'Agent' ? 'outline' : 'ghost'"
          :aria-pressed="attentionOwner === 'Agent'"
          aria-controls="attention-list"
          @click="attentionOwner = 'Agent'"
        >
          Agent tasks <span class="font-mono text-muted">{{ columns.agentTasks.length }}</span>
        </UButton>
      </div>
      <p class="px-2 pb-2 text-sm text-muted">
        {{ attentionOwner === 'You'
          ? 'Your decisions, permissions, or account access. Each row explains what is needed.'
          : 'An agent can handle these next steps. They are not queued. Open a task to copy its instructions.' }}
      </p>
      <div v-if="loading" id="attention-list" class="flex flex-col gap-px border-y border-default" aria-busy="true">
        <USkeleton v-for="row in 3" :key="row" class="h-8 rounded-sm" />
      </div>
      <ul v-else-if="attentionCards.length > 0" id="attention-list" :aria-label="attentionLabel" class="min-h-0 divide-y divide-muted border-y border-default md:overflow-y-auto" role="list">
        <li v-for="(card, index) in attentionCards" :key="card.key">
          <BoardCard
            :ref="component => setNeedsYouCard(index, component)"
            :card="card"
            :tabindex="index === Math.max(focused, 0) ? 0 : -1"
          />
        </li>
      </ul>
      <p v-else id="attention-list" class="border-y border-default px-2 py-2 text-sm text-dimmed">
        {{ attentionOwner === 'You' ? emptyReason('needsYou').text : 'No agent tasks need follow-up.' }}
      </p>
    </section>

    <!-- Questions two to four. Three columns that share the rest of the board. -->
    <div class="grid min-h-0 flex-1 gap-4 md:grid-cols-3">
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
        <!-- Pending work waits on something else, so it folds away until asked for. -->
        <details v-if="columns.waiting.length > 0" class="group/waiting mt-1 shrink-0 border-t border-default pt-1">
          <summary class="flex cursor-pointer list-none items-center gap-2 rounded-sm px-1 py-1.5 text-sm text-muted hover:bg-accented/40 [&::-webkit-details-marker]:hidden">
            <span>Waiting</span>
            <span class="font-mono">{{ columns.waiting.length }}</span>
            <UIcon name="i-octicon-chevron-right-16" class="ms-auto size-4 text-dimmed transition-transform group-open/waiting:rotate-90" aria-hidden="true" />
          </summary>
          <div class="flex flex-col gap-1.5 pt-1">
            <BoardCard v-for="card in columns.waiting" :key="card.key" :card="card" />
          </div>
        </details>
      </BoardColumn>

      <BoardColumn id="running" label="Running" :count="columns.running.length" :tone="columns.running.length > 0 ? 'success' : 'default'" :live="columns.running.length > 0" :loading="loading">
        <BoardCard v-for="card in columns.running" :key="card.key" :card="card" />
        <p v-if="columns.running.length === 0" class="px-1 py-1 text-sm text-dimmed">
          {{ emptyReason('running').text }}
        </p>
      </BoardColumn>

      <BoardColumn id="done" label="Done" :count="columns.doneTotal" :loading="loading">
        <div v-if="columns.done.length > 0" class="shrink-0 divide-y divide-muted overflow-hidden rounded-md border border-default bg-elevated">
          <BoardCard v-for="card in columns.done" :key="card.key" :card="card" />
        </div>
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
