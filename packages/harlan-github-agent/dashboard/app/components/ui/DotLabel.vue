<script setup lang="ts">
/** UiDotLabel — a coloured dot with an optional label, for legends and inline keys. */
const { dotClass, dotSize = '1.5', label } = defineProps<{
  /** Tailwind bg class for the dot, e.g. 'bg-success' */
  dotClass: string
  /** Dot size token: '1.5' (default, inline/legend), '2' (medium), '2.5' (hero) */
  dotSize?: '1.5' | '2' | '2.5'
  /** Optional text label rendered after the dot */
  label?: string
}>()

// Spelled out so Tailwind sees every class it must generate.
const sizeClass = { 1.5: 'size-1.5', 2: 'size-2', 2.5: 'size-2.5' } as const
</script>

<template>
  <span data-ui="UiDotLabel" class="inline-flex items-center gap-1.5">
    <span class="shrink-0 rounded-full" :class="[dotClass, sizeClass[dotSize]]" aria-hidden="true" />
    <slot>
      <span v-if="label">{{ label }}</span>
    </slot>
  </span>
</template>
