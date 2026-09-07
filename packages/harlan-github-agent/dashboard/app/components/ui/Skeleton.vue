<script setup lang="ts">
/**
 * UiSkeleton — loading placeholder with the nuxtseo shape props. `text` draws
 * one line per `lines`; `bar`, `block`, and `circle` draw one shape. The
 * nuxtseo shimmer is dropped: this app animates nothing but the live dot.
 */
const { type = 'text', lines = 1 } = defineProps<{
  type?: 'text' | 'bar' | 'circle' | 'block'
  lines?: number
}>()
</script>

<template>
  <USkeleton v-if="type === 'circle'" class="size-8 rounded-full" />
  <USkeleton v-else-if="type === 'block'" class="h-24 w-full rounded-md" />
  <USkeleton v-else-if="type === 'bar'" class="h-2 w-full rounded-sm" />
  <span v-else class="flex flex-col gap-1.5">
    <USkeleton v-for="line in lines" :key="line" class="h-4 rounded-sm" :class="line === lines && lines > 1 ? 'w-2/3' : 'w-full'" />
  </span>
</template>
