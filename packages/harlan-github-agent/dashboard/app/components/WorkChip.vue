<script setup lang="ts">
import type { AgentRole } from '../../../src/types.ts'
import { workChip } from '../utils/dashboard.ts'

/** Says what a card is for. Neutral by rule: colour on this board means state. */
const { work } = defineProps<{ work: AgentRole }>()

const chip = computed(() => workChip(work))
</script>

<template>
  <UBadge variant="outline" color="neutral" :icon="chip.icon" class="text-toned" :ui="{ leadingIcon: 'text-dimmed' }">
    {{ chip.label }}
  </UBadge>
</template>
