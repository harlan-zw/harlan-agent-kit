<script setup lang="ts">
import type { MarkTip, TimelineMark, TimelineView } from '../utils/timeline.ts'
import { workLabel } from '../utils/dashboard.ts'
import { countdown, xOf } from '../utils/timeline.ts'

/**
 * The marks of one Timeline row. Neutral shapes carry time; colour arrives
 * only with state: green while an Agent runs, amber while you are needed,
 * red when a Review blocks or work fails.
 */
const { marks, view, width, now, height = 44 } = defineProps<{
  marks: TimelineMark[]
  view: TimelineView
  width: number
  now: number
  height?: number
}>()

const emit = defineEmits<{ tip: [tip: MarkTip | null] }>()

const mid = computed(() => height / 2)
const x = (at: number): number => xOf(view, width, at)
const nowX = computed(() => x(now))
const visible = (from: number, to: number): boolean => x(to) >= -12 && x(from) <= width + 12

const clock = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
function length(from: number, to: number): string {
  const minutes = Math.max(1, Math.round((to - from) / 60_000))
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The first upcoming Routine instant gets a countdown. Later ones stay quiet. */
const nextAt = computed(() => marks.filter(mark => mark._tag === 'RoutineNext').map(mark => mark.at).sort((a, b) => a - b)[0])

function tip(event: MouseEvent, title: string, detail: string): void {
  emit('tip', { x: event.clientX, y: event.clientY, title, detail })
}

const diamond = (cx: number, cy: number, r: number): string => `M${cx} ${cy - r}L${cx + r} ${cy}L${cx} ${cy + r}L${cx - r} ${cy}Z`
</script>

<template>
  <svg class="absolute inset-0 overflow-visible" :width="width" :height="height" aria-hidden="true" @mouseleave="emit('tip', null)">
    <template v-for="(mark, index) in marks" :key="index">
      <!-- A delivery that moved this item: a small dot on the row line, ahead of the work it caused. -->
      <g v-if="mark._tag === 'Event' && visible(mark.at, mark.at)" @mouseenter="tip($event, mark.event, `Delivery · ${clock(mark.at)}`)">
        <circle :cx="x(mark.at)" :cy="mid" r="2.4" fill="var(--ui-text-muted)" />
        <rect :x="x(mark.at) - 6" :y="mid - 10" width="12" height="20" fill="transparent" />
      </g>
      <!-- A finished Task: a bar, and a cap when the outcome is a signal. -->
      <g
        v-else-if="mark._tag === 'Span' && visible(mark.start, mark.end)"
        class="cursor-default"
        @mouseenter="tip($event, `${workLabel(mark.work)} · ${mark.outcome ?? 'Finished'}`, `${clock(mark.start)} to ${clock(mark.end)} · ${length(mark.start, mark.end)}`)"
      >
        <rect :x="x(mark.start)" :y="mid - 3" :width="Math.max(3, x(mark.end) - x(mark.start))" height="6" rx="3" fill="var(--canvas-span)" />
        <rect :x="x(mark.start) - 4" :y="mid - 10" :width="Math.max(3, x(mark.end) - x(mark.start)) + 8" height="20" fill="transparent" />
        <circle v-if="mark.outcome === 'READY'" :cx="x(mark.end)" :cy="mid" r="3.75" fill="var(--ui-success)" />
        <circle v-else-if="mark.outcome === 'Failed'" :cx="x(mark.end)" :cy="mid" r="3.75" fill="var(--ui-error)" />
        <circle v-else-if="mark.outcome === 'PENDING'" :cx="x(mark.end)" :cy="mid" r="3.25" fill="var(--canvas-ground)" stroke="var(--ui-warning)" stroke-width="1.6" />
        <circle v-else-if="mark.outcome === 'Needs info'" :cx="x(mark.end)" :cy="mid" r="3.25" fill="var(--canvas-ground)" stroke="var(--ui-text-dimmed)" stroke-width="1.6" />
        <g v-else-if="mark.outcome === 'BLOCKED'" stroke="var(--ui-error)" stroke-width="1.8" stroke-linecap="round">
          <line :x1="x(mark.end) - 3.25" :y1="mid - 3.25" :x2="x(mark.end) + 3.25" :y2="mid + 3.25" />
          <line :x1="x(mark.end) - 3.25" :y1="mid + 3.25" :x2="x(mark.end) + 3.25" :y2="mid - 3.25" />
        </g>
      </g>

      <!-- Running: the bar grows with the now line. -->
      <g
        v-else-if="mark._tag === 'Live'"
        @mouseenter="tip($event, `${workLabel(mark.work)} · running`, `Since ${clock(mark.start)} · ${length(mark.start, now)}`)"
      >
        <rect :x="x(mark.start)" :y="mid - 3" :width="Math.max(3, nowX - x(mark.start))" height="6" rx="3" fill="var(--canvas-span-live)" />
        <circle :cx="nowX" :cy="mid" r="9" fill="var(--ui-success)" opacity="0.18" />
        <circle class="live-dot" :cx="nowX" :cy="mid" r="4.5" fill="var(--ui-success)" />
      </g>

      <!-- Waiting on a decision: how long, drawn as a line that ends on now. -->
      <g
        v-else-if="mark._tag === 'Wait'"
        @mouseenter="tip($event, mark.owner === 'You' ? 'Waiting on you' : 'Waiting on an Agent task', `Since ${clock(mark.since)} · ${length(mark.since, now)}`)"
      >
        <line
          :x1="Math.max(-8, x(mark.since))"
          :y1="mid"
          :x2="nowX - 7"
          :y2="mid"
          :stroke="mark.owner === 'You' ? 'var(--ui-warning)' : 'var(--ui-text-dimmed)'"
          stroke-width="1.6"
          stroke-dasharray="3 4"
        />
        <rect :x="Math.max(-8, x(mark.since))" :y="mid - 10" :width="Math.max(0, nowX - Math.max(-8, x(mark.since)))" height="20" fill="transparent" />
        <path :d="diamond(nowX, mid, 5)" :fill="mark.owner === 'You' ? 'var(--ui-warning)' : 'var(--ui-text-dimmed)'" />
      </g>

      <!-- Queued: a hollow capsule just past now. Position when it has one. -->
      <g v-else-if="mark._tag === 'Queued'">
        <rect :x="nowX + 12" :y="mid - 10" :width="mark.position === null ? 66 : 40" height="20" rx="10" fill="var(--canvas-ground)" stroke="var(--ui-border-accented)" stroke-dasharray="3 3" />
        <text :x="nowX + 12 + (mark.position === null ? 33 : 20)" :y="mid + 4.5" text-anchor="middle" class="fill-(--ui-text-muted) font-mono text-[0.8125rem]">{{ mark.position === null ? 'Waiting' : `#${mark.position}` }}</text>
      </g>

      <!-- A Routine run at its cron instant. A short bar while its Agent turn ran. -->
      <g
        v-else-if="mark._tag === 'RoutineRun' && visible(mark.at, mark.end ?? mark.at)"
        @mouseenter="tip($event, `Routine run · ${mark.result}`, mark.end === null ? clock(mark.at) : `${clock(mark.at)} to ${clock(mark.end)} · ${length(mark.at, mark.end)}`)"
      >
        <rect v-if="mark.end !== null" :x="x(mark.at)" :y="mid - 1" :width="Math.max(0, x(mark.end) - x(mark.at))" height="2" fill="var(--canvas-span)" />
        <path
          :d="diamond(x(mark.at), mid, 5)"
          :fill="mark.result === 'Clear' ? 'var(--ui-text-dimmed)' : mark.result === 'Action required' ? 'var(--ui-warning)' : mark.result === 'Blocked' ? 'var(--ui-error)' : 'var(--canvas-ground)'"
          :stroke="mark.result === 'Unchanged' || mark.result === 'Skipped' ? 'var(--ui-text-dimmed)' : 'none'"
          :stroke-dasharray="mark.result === 'Skipped' ? '2 2' : undefined"
          stroke-width="1.4"
        />
        <rect :x="x(mark.at) - 8" :y="mid - 10" width="16" height="20" fill="transparent" />
      </g>

      <!-- The next run of a Routine: a ghost diamond and, for the first, a countdown. -->
      <g
        v-else-if="mark._tag === 'RoutineNext' && visible(mark.at, mark.at)"
        @mouseenter="tip($event, 'Next run', `${clock(mark.at)} · ${countdown(mark.at, now)}`)"
      >
        <path :d="diamond(x(mark.at), mid, 5.5)" fill="var(--canvas-future)" stroke="var(--ui-text-muted)" stroke-width="1.4" stroke-dasharray="2.2 2" />
        <rect :x="x(mark.at) - 8" :y="mid - 10" width="16" height="20" fill="transparent" />
        <text v-if="mark.at === nextAt" :x="x(mark.at) + 12" :y="mid + 4.5" class="fill-(--ui-text-muted) font-mono text-[0.8125rem]">{{ countdown(mark.at, now) }}</text>
      </g>
    </template>
  </svg>
</template>
