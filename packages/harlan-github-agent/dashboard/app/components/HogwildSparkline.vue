<script setup lang="ts">
import { sparklineProjection } from '../utils/hogwild-status.ts'

const { data, label } = defineProps<{
  data: number[]
  label: string
}>()

const projection = computed(() => sparklineProjection(data))
</script>

<template>
  <svg
    v-if="projection"
    class="shrink-0 overflow-visible text-muted"
    width="96"
    height="24"
    viewBox="0 0 96 24"
    role="img"
    :aria-label="`${label}, ${projection.summary}`"
  >
    <path
      :d="projection.path"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      fill="none"
      vector-effect="non-scaling-stroke"
    />
    <circle :cx="projection.end.x" :cy="projection.end.y" r="1.75" fill="currentColor" />
  </svg>
</template>
