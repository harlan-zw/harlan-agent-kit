<script setup lang="ts">
import type { AgentRole } from '../../../src/types.ts'
import { workChip } from '../utils/dashboard.ts'

/** Says what a card is for: an icon and a word, muted, no box. Colour on this board means state. */
const { work } = defineProps<{ work: AgentRole }>()

const chip = computed(() => workChip(work))
</script>

<template>
  <span class="inline-flex items-center gap-1 whitespace-nowrap text-sm text-muted">
    <UIcon :name="chip.icon" class="size-3.5 shrink-0 text-dimmed" aria-hidden="true" />
    <span>{{ chip.label }}</span>
  </span>
</template>
