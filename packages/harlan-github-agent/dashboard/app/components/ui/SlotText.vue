<script setup lang="ts">
import type { SlotTextOptions } from '../../utils/slot-text.ts'
import { usePreferredReducedMotion } from '@vueuse/core'

/** UiSlotText — rolls each glyph when a metric value changes. Plain text under reduced motion. */
const { text, options } = defineProps<{
  text: string
  options?: SlotTextOptions
}>()

const motionPreference = usePreferredReducedMotion()
const reduced = computed(() => motionPreference.value === 'reduce')
// SSR and the first hydrated frame stay plain text. Character-slot markup only
// appears for a real post-mount update, after the global animation CSS is ready.
// This prevents a slow stylesheet/hydration path from exposing split glyphs.
const mounted = ref(false)
const animateUpdates = ref(false)
onMounted(() => {
  mounted.value = true
})
watch(() => text, (next, previous) => {
  if (mounted.value && next !== previous)
    animateUpdates.value = true
})

const resolvedOptions = computed<SlotTextOptions>(() => ({
  direction: 'up',
  stagger: 32,
  duration: 260,
  exitOffset: 38,
  ...options,
}))

const chars = computed(() => Array.from(text))
const directionClass = computed(() => resolvedOptions.value.direction === 'down' ? 'ui-slot-text--down' : 'ui-slot-text--up')

function glyph(char: string): string {
  return char === ' ' ? ' ' : char
}

function slotStyle(index: number): Record<string, string> {
  return {
    '--ui-slot-delay': `${index * (resolvedOptions.value.stagger ?? 32)}ms`,
    '--ui-slot-duration': `${resolvedOptions.value.duration ?? 260}ms`,
    '--ui-slot-easing': resolvedOptions.value.easing ?? 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  }
}
</script>

<template>
  <span v-if="reduced || !animateUpdates" class="ui-slot-text-host">{{ text }}</span>
  <span v-else class="ui-slot-text-host ui-slot-text" :class="directionClass" :aria-label="text">
    <span
      v-for="(char, index) in chars"
      :key="index"
      class="ui-slot-text__slot"
      :style="slotStyle(index)"
      aria-hidden="true"
    >
      <span class="ui-slot-text__sizer">{{ glyph(char) }}</span>
      <Transition name="ui-slot-text-roll">
        <span :key="`${index}:${char}`" class="ui-slot-text__face">{{ glyph(char) }}</span>
      </Transition>
    </span>
  </span>
</template>

<style>
.ui-slot-text {
  display: inline-flex;
  white-space: pre;
}

.ui-slot-text__slot {
  position: relative;
  display: inline-flex;
  flex: none;
  justify-content: center;
  overflow-x: visible;
  overflow-y: clip;
  line-height: 1.3;
  vertical-align: bottom;
}

.ui-slot-text__sizer {
  visibility: hidden;
  white-space: pre;
}

.ui-slot-text__face {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  white-space: pre;
  transition:
    transform var(--ui-slot-duration, 260ms) var(--ui-slot-easing, cubic-bezier(0.34, 1.56, 0.64, 1)) var(--ui-slot-delay, 0ms),
    opacity var(--ui-slot-duration, 260ms) var(--ease-out) var(--ui-slot-delay, 0ms);
  will-change: transform, opacity;
}

.ui-slot-text-roll-enter-from,
.ui-slot-text-roll-leave-to {
  opacity: 0;
}

.ui-slot-text--up .ui-slot-text-roll-enter-from {
  transform: translateY(105%);
}

.ui-slot-text--up .ui-slot-text-roll-leave-to {
  transform: translateY(-105%);
}

.ui-slot-text--down .ui-slot-text-roll-enter-from {
  transform: translateY(-105%);
}

.ui-slot-text--down .ui-slot-text-roll-leave-to {
  transform: translateY(105%);
}

.ui-slot-text-roll-enter-to,
.ui-slot-text-roll-leave-from {
  opacity: 1;
  transform: translateY(0);
}
</style>
