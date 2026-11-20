<script setup lang="ts">
import type { MarkTip, TimelineHistory, TimelineRow, TimelineSection, TimelineView } from '../utils/timeline.ts'
import { refDebounced, useElementSize, useEventListener, useIntervalFn, useMediaQuery } from '@vueuse/core'
import { incidentEntries, repositoryName } from '../utils/dashboard.ts'
import { isTypingTarget, overlayOpen } from '../utils/keyboard.ts'
import {
  clampScale,
  deliveriesLastHour,
  deliveryBins,
  followView,
  parseTimelineHistory,
  spanLabel,
  timeAt,
  timelineSections,
  timeTicks,
  xOf,
  zoomAt,
  zoomPresets,
} from '../utils/timeline.ts'
import BoardCard from './_BoardCard.vue'
import BoardIncidentRow from './_BoardIncidentRow.vue'
import TimelineMarks from './_TimelineMarks.vue'

/**
 * The Timeline. Time runs left to right and now rests at three quarters of the
 * width, so the next hour is always in view. Rows answer the Board's questions
 * in order: Needs you, Running, Up next, Routines, then what already happened.
 * The page owns the view and the pointer; the utils own every number.
 */
definePageMeta({ layout: 'canvas' })
usePageTitle('Timeline')
useHead({ meta: [{ name: 'description', content: 'GitHub deliveries, Agent work, and Routines on one live Timeline.' }] })

const { snapshot, loading, now: clockNow, relativeTime, setAgentControl, controlPending, isStale } = useDashboard()
const now = computed(() => clockNow.value.getTime())

/* ---------- History ---------- */

const history = shallowRef<TimelineHistory>()
const historyError = ref(false)
async function loadHistory(): Promise<void> {
  await $fetch<unknown>('/api/timeline', { timeout: 15_000 })
    .then((value) => {
      const parsed = parseTimelineHistory(value)
      history.value = parsed
      historyError.value = parsed === undefined
    })
    .catch(() => {
      // The Service has no Timeline API yet. The rows still come from the live snapshot.
      historyError.value = true
    })
}
onMounted(loadHistory)
useIntervalFn(loadHistory, 60_000)

/* ---------- View ---------- */

const rowHeight = 48
const scroller = useTemplateRef<HTMLElement>('scroller')
const { width: scrollerWidth } = useElementSize(scroller)
/** Below md the canvas has no room. Rows read as a list, in the same order. */
const narrow = useMediaQuery('(max-width: 767px)')
const gutter = computed(() => narrow.value ? scrollerWidth.value : 360)
const width = computed(() => Math.max(0, scrollerWidth.value - gutter.value))

const follow = ref(true)
const scale = ref(0)
const pinned = ref<TimelineView>({ msPerPx: 1, end: 0 })
watch(width, (value, previous) => {
  if (value > 0 && (scale.value === 0 || !previous))
    scale.value = clampScale((6 * 3_600_000) / value)
}, { immediate: true })

const view = computed<TimelineView>(() => follow.value
  ? followView(now.value, width.value, scale.value || 1)
  : pinned.value)
const nowX = computed(() => xOf(view.value, width.value, now.value))
const from = computed(() => timeAt(view.value, width.value, 0))
const to = computed(() => view.value.end)

function pan(dx: number): void {
  pinned.value = { msPerPx: view.value.msPerPx, end: view.value.end + dx * view.value.msPerPx }
  follow.value = false
}

function zoom(x: number, factor: number): void {
  const anchor = follow.value ? nowX.value : x
  const next = zoomAt(view.value, width.value, anchor, factor)
  scale.value = next.msPerPx
  pinned.value = next
}

function setSpan(span: number): void {
  const factor = span / (view.value.msPerPx * width.value)
  zoom(nowX.value, factor)
}

function backToNow(): void {
  follow.value = true
}

/** Decisions ride the now line. When now is off screen they wait at the nearest edge. */
const actionLeft = computed(() => gutter.value + Math.min(Math.max(nowX.value + 14, 8), width.value - 176))

/* Rows refresh after panning settles, so the list never reshuffles under the pointer. */
/** The list on a phone covers the last six hours and the next two, like the default view. */
const range = computed(() => narrow.value
  ? { from: now.value - 6 * 3_600_000, to: now.value + 2 * 3_600_000 }
  : { from: from.value, to: to.value })
const settledRange = refDebounced(range, 250)
const sections = computed<TimelineSection[]>(() => timelineSections({
  snapshot: snapshot.value,
  history: history.value,
  now: now.value,
  from: settledRange.value.from,
  to: settledRange.value.to,
}))
const openSections = ref(new Set<string>())
function rowsOf(section: TimelineSection): TimelineRow[] {
  return openSections.value.has(section._tag) ? [...section.rows, ...section.folded] : section.rows
}
function toggleSection(tag: string): void {
  const next = new Set(openSections.value)
  if (next.has(tag))
    next.delete(tag)
  else next.add(tag)
  openSections.value = next
}

/* ---------- Ruler, grid, deliveries ---------- */

const ticks = computed(() => width.value > 0 ? timeTicks(view.value, width.value) : [])
const dayLabel = computed(() => new Date(from.value).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))
const paused = computed(() => snapshot.value.agentControl._tag === 'Paused')

const binMinutes = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440]
const bins = computed(() => {
  const series = history.value?.deliveries
  if (!series || width.value === 0)
    return []
  const target = view.value.msPerPx * 5
  const minutes = binMinutes.find(value => value * 60_000 >= target) ?? 1440
  return deliveryBins(series, from.value - minutes * 60_000, Math.min(to.value, now.value), minutes * 60_000)
})
const deliveryHeight = 30
const binPeak = computed(() => Math.max(1, ...bins.value.map(bin => bin.count)))
const deliveryPath = computed(() => bins.value.map((bin) => {
  const x0 = xOf(view.value, width.value, bin.start) + 0.5
  const x1 = xOf(view.value, width.value, bin.end) - 0.5
  const h = bin.count === 0 ? 0 : Math.max(1, Math.sqrt(bin.count / binPeak.value) * deliveryHeight)
  return h === 0 ? '' : `M${x0.toFixed(1)} ${deliveryHeight}H${Math.max(x0 + 1, x1).toFixed(1)}V${(deliveryHeight - h).toFixed(1)}H${x0.toFixed(1)}Z`
}).join(''))
const lastHour = computed(() => history.value ? deliveriesLastHour(history.value.deliveries) : undefined)

/* ---------- Pointer ---------- */

const tip = ref<MarkTip | null>(null)
function showTip(value: MarkTip | null): void {
  if (!dragging.value)
    tip.value = value
}

function deliveryTip(event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement
  const x = event.clientX - target.getBoundingClientRect().left
  const at = timeAt(view.value, width.value, x)
  const bin = bins.value.find(candidate => candidate.start <= at && at < candidate.end)
  const clock = (value: number): string => new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  showTip(bin ? { x: event.clientX, y: event.clientY, title: `${bin.count.toLocaleString()} deliveries`, detail: `${clock(bin.start)} to ${clock(bin.end)}` } : null)
}

const dragging = ref(false)
let dragX = 0
function canvasX(event: { clientX: number }): number | undefined {
  const rect = scroller.value?.getBoundingClientRect()
  if (!rect)
    return undefined
  const x = event.clientX - rect.left - gutter.value
  return x >= 0 ? x : undefined
}

function pointerDown(event: PointerEvent): void {
  if (event.button !== 0 || canvasX(event) === undefined || (event.target as Element).closest('a, button, [role="menuitem"]'))
    return
  dragging.value = true
  dragX = event.clientX
  tip.value = null
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function pointerMove(event: PointerEvent): void {
  if (!dragging.value)
    return
  pan(dragX - event.clientX)
  dragX = event.clientX
}
function pointerUp(): void {
  dragging.value = false
}

useEventListener(scroller, 'wheel', (event: WheelEvent) => {
  const x = canvasX(event)
  if (x === undefined)
    return
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault()
    zoom(x, Math.exp(event.deltaY * 0.0025))
    return
  }
  if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    event.preventDefault()
    pan(event.shiftKey ? event.deltaY : event.deltaX)
  }
}, { passive: false })

/* ---------- Keyboard: j and k walk Needs you, a presses its one action. ---------- */

const needsYouCards = ref<Array<InstanceType<typeof BoardCard> | null>>([])
const focused = ref(-1)
function setNeedsYouCard(index: number, component: unknown): void {
  needsYouCards.value[index] = component as InstanceType<typeof BoardCard> | null
}
const needsYouCount = computed(() => sections.value.find(section => section._tag === 'NeedsYou')?.rows.length ?? 0)

useEventListener('keydown', (event: KeyboardEvent) => {
  if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target) || overlayOpen(document))
    return
  const step = (direction: number): void => {
    if (needsYouCount.value === 0)
      return
    focused.value = Math.min(Math.max(focused.value + direction, 0), needsYouCount.value - 1)
    needsYouCards.value[focused.value]?.focus()
  }
  const handlers: Record<string, () => void> = {
    'j': () => step(1),
    'k': () => step(-1),
    'a': () => focused.value >= 0 && needsYouCards.value[focused.value]?.pressPrimary(),
    '.': backToNow,
    '+': () => zoom(nowX.value, 0.7),
    '=': () => zoom(nowX.value, 0.7),
    '-': () => zoom(nowX.value, 1 / 0.7),
    'ArrowLeft': () => pan(-width.value * 0.1),
    'ArrowRight': () => pan(width.value * 0.1),
  }
  const handler = handlers[event.key]
  if (!handler)
    return
  event.preventDefault()
  handler()
})

const incidents = computed(() => incidentEntries(snapshot.value.incidents))
const topIncident = computed(() => incidents.value[0])

function openSystem(): void {
  window.dispatchEvent(new CustomEvent('open-system'))
}

const presetItems = computed(() => [zoomPresets.map(preset => ({ label: preset.label, onSelect: () => setSpan(preset.span) }))])
const kindIcon = { issue: 'i-octicon-issue-opened-16', pull_request: 'i-octicon-git-pull-request-16' }
</script>

<template>
  <div class="relative flex h-full flex-col">
    <h1 class="sr-only">
      Timeline
    </h1>

    <BoardIncidentRow
      v-if="topIncident"
      class="mx-3 mb-2 shrink-0"
      :incident="topIncident"
      :age="relativeTime(topIncident.lastSeenAt)"
      :more="incidents.length - 1"
      @open="openSystem"
    />

    <div
      ref="scroller"
      class="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
      :class="dragging ? 'cursor-grabbing select-none' : undefined"
      @pointerdown="pointerDown"
      @pointermove="pointerMove"
      @pointerup="pointerUp"
      @pointercancel="pointerUp"
    >
      <div class="relative min-h-full pb-24">
        <!-- Grid and the future. Behind every row, for the full height. -->
        <div v-if="!narrow" class="pointer-events-none absolute inset-y-0 right-0" :style="{ left: `${gutter}px` }" aria-hidden="true">
          <div class="absolute inset-y-0 right-0 bg-(--canvas-future)" :style="{ left: `${Math.max(0, nowX)}px` }" />
          <div v-for="tick in ticks" :key="tick.at" class="absolute inset-y-0 w-px" :class="tick.day ? 'bg-(--ui-border)' : 'bg-(--canvas-grid)'" :style="{ left: `${xOf(view, width, tick.at)}px` }" />
        </div>

        <!-- Ruler and deliveries stay put while rows scroll. -->
        <div v-if="!narrow" class="sticky top-0 z-20 bg-(--canvas-ground)">
          <div class="relative grid h-8" :style="{ gridTemplateColumns: `${gutter}px 1fr` }">
            <div class="flex items-center ps-5 text-sm font-medium text-toned">
              {{ dayLabel }}
            </div>
            <div class="relative overflow-hidden" aria-hidden="true">
              <div class="absolute inset-y-0 right-0 bg-(--canvas-future)" :style="{ left: `${Math.max(0, nowX)}px` }" />
              <template v-for="tick in ticks" :key="tick.at">
                <span
                  v-if="Math.abs(xOf(view, width, tick.at) - nowX) > 44"
                  class="absolute top-1.5 -translate-x-1/2 font-mono text-[0.8125rem] whitespace-nowrap"
                  :class="tick.day ? 'font-sans font-medium text-toned' : 'text-dimmed'"
                  :style="{ left: `${xOf(view, width, tick.at)}px` }"
                >{{ tick.label }}</span>
              </template>
              <span
                class="absolute top-1 flex h-6 -translate-x-1/2 items-center rounded-full px-2.5 font-mono text-[0.8125rem] font-medium text-inverted"
                :class="paused ? 'bg-warning' : 'bg-(--canvas-now)'"
                :style="{ left: `${nowX}px` }"
              >{{ paused ? 'Paused' : clockNow.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }}</span>
            </div>
          </div>

          <div class="relative grid border-b border-(--canvas-grid)" :style="{ gridTemplateColumns: `${gutter}px 1fr`, height: '52px' }">
            <div class="flex items-center gap-3 ps-5 pe-4">
              <UIcon name="i-octicon-broadcast-16" class="size-4 shrink-0 text-dimmed" aria-hidden="true" />
              <div class="min-w-0 leading-tight">
                <p class="text-sm text-highlighted">
                  Deliveries
                </p>
                <p class="mt-0.5 font-mono text-[0.8125rem] text-dimmed">
                  {{ historyError ? 'No records yet' : lastHour === undefined ? '…' : `${lastHour.toLocaleString()} in the last hour` }}
                </p>
              </div>
            </div>
            <div class="relative overflow-hidden" @pointermove="deliveryTip" @pointerleave="showTip(null)">
              <div class="absolute inset-y-0 right-0 bg-(--canvas-future)" :style="{ left: `${Math.max(0, nowX)}px` }" />
              <svg class="absolute inset-x-0 bottom-2" :width="width" :height="deliveryHeight" aria-hidden="true">
                <path :d="deliveryPath" fill="var(--canvas-texture)" />
              </svg>
            </div>
          </div>
        </div>

        <!-- Sections. -->
        <section v-for="section in sections" :key="section._tag" class="relative" :aria-label="`${section.label}, ${section.rows.length + section.folded.length}`">
          <div class="grid h-10 items-end pb-1.5" :style="{ gridTemplateColumns: `${gutter}px 1fr` }">
            <h2 class="flex items-center gap-2 ps-5 text-sm font-medium text-toned">
              <LiveDot v-if="section._tag === 'NeedsYou' && section.rows.length > 0" tone="warning" />
              <LiveDot v-else-if="section._tag === 'Running' && section.rows.length > 0" tone="success" live />
              {{ section.label }}
              <span class="font-mono font-normal" :class="section._tag === 'NeedsYou' && section.rows.length > 0 ? 'text-warning' : 'text-dimmed'">{{ section.rows.length + section.folded.length }}</span>
            </h2>
          </div>

          <p v-if="section.rows.length === 0 && !loading" class="ps-5 pb-2 text-sm text-dimmed">
            Nothing needs you.
          </p>

          <div
            v-for="(row, index) in rowsOf(section)"
            :key="row.key"
            class="group relative grid transition-colors hover:bg-(--canvas-row-hover)"
            :style="{ gridTemplateColumns: `${gutter}px 1fr`, height: `${rowHeight}px` }"
          >
            <div class="relative min-w-0">
              <BoardCard
                v-if="row._tag === 'Card'"
                :ref="component => section._tag === 'NeedsYou' && setNeedsYouCard(index, component)"
                :card="row.card"
                face="timeline"
                :action-left="narrow ? undefined : actionLeft"
                :tabindex="section._tag === 'NeedsYou' && index !== Math.max(focused, 0) ? -1 : 0"
              />
              <div v-else-if="row._tag === 'Item'" class="flex h-full items-center gap-3 ps-4 pe-4">
                <UIcon :name="kindIcon[row.item.kind]" class="size-4 shrink-0 text-dimmed" aria-hidden="true" />
                <div class="min-w-0 leading-tight">
                  <p class="truncate text-sm text-toned" :title="row.item.title">
                    {{ row.item.title }}
                  </p>
                  <a :href="row.item.url" target="_blank" rel="noreferrer" class="entity-link mt-0.5 block truncate font-mono text-[0.8125rem] text-dimmed">{{ repositoryName(row.item.repository) }} #{{ row.item.number }}</a>
                </div>
              </div>
              <div v-else class="flex h-full items-center gap-3 ps-4 pe-4">
                <UIcon name="i-octicon-calendar-16" class="size-4 shrink-0 text-dimmed" aria-hidden="true" />
                <div class="min-w-0 leading-tight">
                  <p class="truncate text-sm text-toned">
                    {{ row.name }}
                  </p>
                  <p class="mt-0.5 truncate font-mono text-[0.8125rem] text-dimmed">
                    {{ repositoryName(row.repository) }}
                  </p>
                </div>
              </div>
            </div>
            <div class="relative overflow-hidden">
              <TimelineMarks :marks="row.marks" :view="view" :width="width" :now="now" :height="rowHeight" @tip="showTip" />
            </div>
          </div>

          <button
            v-if="section.folded.length > 0"
            type="button"
            class="ms-5 mt-1 mb-2 flex items-center gap-1.5 rounded-sm text-sm text-muted hover:text-highlighted"
            @click="toggleSection(section._tag)"
          >
            <UIcon :name="openSections.has(section._tag) ? 'i-octicon-chevron-up-16' : 'i-octicon-chevron-down-16'" class="size-4" aria-hidden="true" />
            {{ openSections.has(section._tag) ? 'Show less' : `${section.folded.length} more` }}
          </button>
        </section>

        <!-- Now. One line through every row, drawn last so it stays on top. -->
        <div v-if="!narrow" class="pointer-events-none absolute inset-y-0 z-30 w-px" :class="paused ? 'bg-warning' : 'bg-(--canvas-now)'" :style="{ left: `${gutter + nowX}px` }" aria-hidden="true" />
      </div>
    </div>

    <!-- Zoom and live. -->
    <div v-if="!narrow" class="canvas-cluster absolute bottom-3 left-3 z-40">
      <UButton
        color="neutral"
        variant="ghost"
        size="sm"
        :aria-pressed="follow"
        @click="backToNow"
      >
        <LiveDot :tone="follow && !isStale ? 'success' : 'neutral'" :live="follow && !isStale" />
        Live
      </UButton>
      <span class="h-5 w-px bg-(--ui-border)" aria-hidden="true" />
      <UButton icon="i-octicon-dash-16" color="neutral" variant="ghost" size="sm" square aria-label="Zoom out" @click="zoom(nowX, 1 / 0.7)" />
      <UDropdownMenu :items="presetItems" :content="{ side: 'top', align: 'center' }">
        <UButton color="neutral" variant="ghost" size="sm" class="min-w-12 justify-center" aria-label="Zoom presets">
          <span class="font-mono">{{ width > 0 ? spanLabel(view, width) : '6h' }}</span>
        </UButton>
      </UDropdownMenu>
      <UButton icon="i-octicon-plus-16" color="neutral" variant="ghost" size="sm" square aria-label="Zoom in" @click="zoom(nowX, 0.7)" />
    </div>

    <div v-if="paused || !follow" class="absolute bottom-3 left-1/2 z-40 flex -translate-x-1/2 gap-2">
      <UButton v-if="paused" icon="i-octicon-play-16" :loading="controlPending" :disabled="controlPending" @click="setAgentControl('resume')">
        Resume
      </UButton>
      <UButton v-if="!follow" icon="i-octicon-arrow-right-16" color="neutral" variant="subtle" @click="backToNow">
        Back to now
      </UButton>
    </div>

    <!-- What a mark means, at the pointer. -->
    <div
      v-if="tip"
      class="pointer-events-none fixed z-50 rounded-md border border-(--ui-border-accented) bg-(--ui-bg-elevated) px-3 py-2 shadow-lg"
      :style="{ left: `${tip.x + 14}px`, top: `${tip.y + 14}px` }"
      role="tooltip"
    >
      <p class="text-sm text-highlighted">
        {{ tip.title }}
      </p>
      <p class="font-mono text-[0.8125rem] text-muted">
        {{ tip.detail }}
      </p>
    </div>
  </div>
</template>
