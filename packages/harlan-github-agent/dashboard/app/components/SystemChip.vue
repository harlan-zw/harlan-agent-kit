<script setup lang="ts">
import { systemChipState } from '../utils/system.ts'

/**
 * `n/max` agents and one state dot. Grey is normal, amber names why work cannot
 * start, red carries the Incident count. Everything else waits in the slideover.
 */
const { snapshot } = useDashboard()
const { show } = useSystemPane()

const chip = computed(() => systemChipState(snapshot.value))

const tone = computed(() => {
  if (chip.value._tag === 'Incident')
    return 'error'
  return chip.value._tag === 'CannotStart' ? 'warning' : 'neutral'
})

const incidentLabel = computed(() => chip.value._tag === 'Incident'
  ? `${chip.value.incidents} ${chip.value.incidents === 1 ? 'Incident' : 'Incidents'}`
  : undefined)

const ariaLabel = computed(() => {
  if (chip.value._tag === 'Loading')
    return 'System: loading'
  const agents = `${chip.value.active} of ${chip.value.maximum} agents running`
  if (chip.value._tag === 'Incident')
    return `System: ${agents}, ${incidentLabel.value}`
  if (chip.value._tag === 'CannotStart')
    return `System: ${agents}, ${chip.value.reason}`
  return `System: ${agents}`
})
</script>

<template>
  <UButton color="neutral" variant="outline" size="sm" :aria-label="ariaLabel" title="System" @click="show">
    <LiveDot :tone="tone" :live="chip._tag !== 'Loading' && chip.live" />
    <span v-if="chip._tag === 'Loading'" class="font-mono text-dimmed">…</span>
    <span v-else class="font-mono">{{ chip.active }}/{{ chip.maximum }}</span>
    <span v-if="chip._tag === 'CannotStart'" class="status-warning">{{ chip.reason }}</span>

    <span v-else-if="chip._tag === 'Incident'" class="status-error">{{ incidentLabel }}</span>
  </UButton>
</template>
