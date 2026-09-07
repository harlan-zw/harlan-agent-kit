<script setup lang="ts">
/**
 * UiTooltip — thin wrapper over Nuxt UI's tooltip with the nuxtseo prop names
 * the ported components use. `triggerAs` picks the trigger element; the
 * nuxtseo version also rendered rich titles and HTML, which nothing here needs.
 */
const { text, side = 'top', delayDuration = 200, triggerAs = 'span', disabled = false } = defineProps<{
  text?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  delayDuration?: number
  triggerAs?: 'span' | 'button' | 'child'
  disabled?: boolean
}>()
</script>

<template>
  <UTooltip :text="text" :content="{ side }" :delay-duration="delayDuration" :disabled="disabled">
    <button v-if="triggerAs === 'button'" type="button" class="inline-flex items-center">
      <slot />
    </button>
    <span v-else-if="triggerAs === 'span'" class="inline-flex items-center">
      <slot />
    </span>
    <slot v-else />
  </UTooltip>
</template>
