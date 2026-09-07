<script setup lang="ts">
import type { UiTableCellProps, UiTableSize } from '../../utils/table.ts'
import { computed } from 'vue'
import { uiTableCellSizeClass, uiTableVisibleFromClass } from '../../utils/table.ts'

/** Port of nuxtseo design-system UiTableTd: a body cell, or a row header with `rowHeader`. */
const {
  align = 'left',
  size = 'md',
  noPadding = false,
  numeric = false,
  rowHeader = false,
  visibleFrom,
} = defineProps<UiTableCellProps & {
  size?: UiTableSize
  noPadding?: boolean
  rowHeader?: boolean
}>()

const resolvedAlign = computed(() => numeric ? 'right' : align)
const textAlign = computed(() => resolvedAlign.value === 'right' ? 'text-right' : resolvedAlign.value === 'center' ? 'text-center' : 'text-left')
const padClass = computed(() => noPadding ? '' : 'px-3')
</script>

<template>
  <component
    :is="rowHeader ? 'th' : 'td'"
    :scope="rowHeader ? 'row' : undefined"
    class="relative text-sm font-normal text-default"
    :class="[
      uiTableCellSizeClass[size],
      padClass,
      textAlign,
      numeric ? 'font-mono' : '',
      visibleFrom ? uiTableVisibleFromClass[visibleFrom] : '',
    ]"
  >
    <slot />
  </component>
</template>
