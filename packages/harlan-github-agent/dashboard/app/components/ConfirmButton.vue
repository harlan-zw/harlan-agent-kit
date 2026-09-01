<script setup lang="ts">
import type { ButtonProps } from '@nuxt/ui'

/**
 * Arms on the first press, fires on the second, disarms after five seconds.
 *
 * Cancel and Eject both end minutes of agent work, so neither may fire on one
 * misclick. Colour arrives only once the button is armed.
 */
const {
  label,
  confirmLabel,
  ariaLabel,
  confirmAriaLabel,
  color = 'error',
  icon,
  loading = false,
  disabled = false,
  size = 'sm',
} = defineProps<{
  label: string
  confirmLabel: string
  ariaLabel: string
  confirmAriaLabel: string
  color?: ButtonProps['color']
  icon: string
  loading?: boolean
  disabled?: boolean
  size?: ButtonProps['size']
}>()

const emit = defineEmits<{ confirm: [] }>()

const armWindowMilliseconds = 5_000
const armed = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

function press(): void {
  clearTimeout(timer)
  if (armed.value) {
    armed.value = false
    emit('confirm')
    return
  }
  armed.value = true
  timer = setTimeout(() => {
    armed.value = false
  }, armWindowMilliseconds)
}

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <UButton
    :size="size"
    :color="armed ? color : 'neutral'"
    :variant="armed ? 'outline' : 'ghost'"
    :icon="icon"
    :loading="loading"
    :disabled="disabled"
    :aria-label="armed ? confirmAriaLabel : ariaLabel"
    @click="press"
  >
    {{ armed ? confirmLabel : label }}
  </UButton>
</template>
