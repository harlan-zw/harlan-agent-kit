<script setup lang="ts">
import type { Incident } from '../../../src/types.ts'
import { incidentKindLabel, incidentRecoveryLabel, incidentScopeLabel, incidentUrl } from '../utils/dashboard.ts'

/**
 * The one System fact that interrupts watching: an unresolved Incident.
 *
 * The kind is the button that opens the System slideover and the scope is a
 * link to GitHub. The row itself also opens System on a pointer click that
 * lands on neither, so nothing interactive ever nests.
 */
const { incident, age, more = 0 } = defineProps<{
  incident: Incident
  /** Relative time of the last occurrence, formatted by the caller. */
  age: string
  /** How many further Incidents are open behind this one. */
  more?: number
}>()

const emit = defineEmits<{ open: [] }>()

const scope = computed(() => incidentScopeLabel(incident))
const url = computed(() => incidentUrl(incident))

function rowClick(event: MouseEvent): void {
  if (event.target instanceof Element && event.target.closest('a, button') !== null)
    return
  emit('open')
}
</script>

<template>
  <div
    class="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-error/30 bg-error/5 px-3 py-2 text-sm"
    role="group"
    aria-label="Incident"
    @click="rowClick"
  >
    <button type="button" class="status-error flex items-center gap-2 font-medium" @click="emit('open')">
      <UIcon name="i-octicon-alert-16" class="size-4 shrink-0" aria-hidden="true" />
      <span>{{ incidentKindLabel(incident) }}</span>
      <span class="sr-only">. Open System.</span>
    </button>
    <a v-if="url" :href="url" target="_blank" rel="noreferrer" class="entity-link font-mono text-sm text-toned">{{ scope }}</a>
    <span v-else class="font-mono text-sm text-toned">{{ scope }}</span>
    <span class="min-w-0 flex-1 truncate text-default">{{ incident.message }}</span>
    <span class="text-muted">{{ incidentRecoveryLabel(incident) }}</span>
    <span class="font-mono text-sm text-dimmed">{{ incident.occurrences }}×</span>
    <time class="font-mono text-sm text-dimmed" :datetime="incident.lastSeenAt">{{ age }}</time>
    <span v-if="more > 0" class="font-mono text-sm text-dimmed">and {{ more }} more</span>
  </div>
</template>
