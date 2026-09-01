<script setup lang="ts">
/** A label, a count pill, and a hairline. Never a title. Level 1 only for the one page heading. */
const { label, count, tone = 'default', level = 2 } = defineProps<{
  label: string
  count?: number
  tone?: 'default' | 'warning' | 'error'
  level?: 1 | 2
}>()

const labelClass = { default: '', warning: 'status-warning', error: 'status-error' }
const ruleClass = { default: 'bg-border', warning: 'bg-warning', error: 'bg-error' }
</script>

<template>
  <div class="flex min-h-6 items-center gap-2">
    <component :is="`h${level}`" class="field-label" :class="labelClass[tone]">
      {{ label }}
    </component>

    <UBadge v-if="count !== undefined" variant="subtle" color="neutral" class="font-mono font-semibold">
      {{ count }}
    </UBadge>
    <span class="h-px flex-1" :class="ruleClass[tone]" aria-hidden="true" />
  </div>
</template>
