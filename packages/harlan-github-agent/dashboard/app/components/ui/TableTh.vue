<script setup lang="ts">
import type { UiTableCellProps } from '../../utils/table.ts'
import { computed } from 'vue'
import { uiTableVisibleFromClass } from '../../utils/table.ts'

/** Port of nuxtseo design-system UiTableTh: a column header, optionally sortable. */
const {
  align = 'left',
  sortable = false,
  noPadding = false,
  numeric = false,
  sortDirection = false,
  ariaLabel,
  visibleFrom,
} = defineProps<UiTableCellProps & {
  sortable?: boolean
  noPadding?: boolean
  sortDirection?: 'asc' | 'desc' | false
  ariaLabel?: string
}>()

const emit = defineEmits<{ sort: [event: MouseEvent] }>()

const resolvedAlign = computed(() => numeric ? 'right' : align)
const justify = computed(() => resolvedAlign.value === 'right' ? 'justify-end' : resolvedAlign.value === 'center' ? 'justify-center' : 'justify-start')
// Vertical padding lives here, not on the consumer's <tr>. This primitive
// exists for hand-rolled tables where there is no sized header row — without
// `py-*` the label's line box is the entire header height and the text sits
// jammed against the bottom border.
const padClass = computed(() => noPadding || sortable ? '' : 'px-3 py-2.5')
const sortIcon = computed(() => sortDirection ? 'collapse' : 'sort')
const sortIconClass = computed(() => sortDirection === 'desc' ? 'rotate-180' : '')
</script>

<template>
  <th
    scope="col"
    class="field-label border-b border-default bg-default text-left whitespace-nowrap"
    :class="[padClass, numeric ? 'text-right' : '', visibleFrom ? uiTableVisibleFromClass[visibleFrom] : '']"
    :aria-sort="sortable ? sortDirection === 'asc' ? 'ascending' : sortDirection === 'desc' ? 'descending' : 'none' : undefined"
  >
    <button
      v-if="sortable"
      type="button"
      class="field-label flex min-h-11 w-full items-center gap-1 rounded-sm px-2 py-2.5 transition-colors hover:text-default sm:min-h-0"
      :class="justify"
      :aria-label="ariaLabel"
      @click="emit('sort', $event)"
    >
      <slot />
      <UiIcon :name="sortIcon" class="size-3.5 text-dimmed transition-transform duration-150" :class="sortIconClass" aria-hidden="true" />
    </button>
    <div v-else class="flex items-center gap-1" :class="justify">
      <slot />
    </div>
  </th>
</template>
