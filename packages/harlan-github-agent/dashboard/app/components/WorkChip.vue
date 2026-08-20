<script setup lang="ts">
import type { AgentRole } from '../../../src/types.ts'
import { workChip } from '../utils/dashboard.ts'

/** Says what a card is for. Neutral by rule: colour on this board means state. */
const { work } = defineProps<{ work: AgentRole }>()

const chip = computed(() => workChip(work))
</script>

<template>
  <span class="inline-flex items-center gap-1 rounded-sm border border-default bg-muted/60 px-1.5 py-0.5 text-xs font-medium text-toned">
    <UIcon :name="chip.icon" class="size-3.5 shrink-0 text-dimmed" aria-hidden="true" />
    {{ chip.label }}
  </span>
</template>
