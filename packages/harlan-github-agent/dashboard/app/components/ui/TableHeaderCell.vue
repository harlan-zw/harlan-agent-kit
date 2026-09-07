<script setup lang="ts">
import { computed } from 'vue'

/**
 * Port of nuxtseo design-system UiTableHeaderCell without TanStack: the
 * header's label, alignment, tooltip, and sort control come in as props.
 */
const {
  label,
  columnId,
  align = 'left',
  numeric = false,
  tooltip,
  sortable = false,
  sortDirection = false,
} = defineProps<{
  label?: string
  /** Names the column for the sort event and for the empty-label aria name. */
  columnId: string
  align?: 'left' | 'center' | 'right'
  numeric?: boolean
  tooltip?: string
  sortable?: boolean
  sortDirection?: 'asc' | 'desc' | false
}>()

const emit = defineEmits<{ sort: [columnId: string] }>()

const justifyClass = computed(() => {
  if (align === 'center')
    return 'justify-center'
  if (align === 'right' || numeric)
    return 'justify-end'
  return 'justify-start'
})

const isHeaderEmpty = computed(() => label === '' || label == null)

const sortIcon = computed(() => sortDirection ? 'collapse' : 'sort')

// Chevron rotates 180° between asc/desc — a single icon animates rather than swapping.
const sortIconRotate = computed(() => sortDirection === 'desc' ? 'rotate-180' : '')

const buttonClass = 'field-label flex min-h-11 w-full cursor-pointer items-center gap-1 rounded-sm transition-colors select-none sm:min-h-0'
</script>

<template>
  <UiTooltip v-if="tooltip" :text="tooltip">
    <button
      v-if="sortable"
      type="button"
      :class="[buttonClass, justifyClass, sortDirection ? 'text-highlighted' : 'hover:text-default']"
      :aria-label="isHeaderEmpty ? `Sort by ${columnId}` : undefined"
      @click.stop="emit('sort', columnId)"
    >
      {{ label }}
      <UiIcon :name="sortIcon" class="size-3.5 text-dimmed transition-transform duration-150" :class="sortIconRotate" aria-hidden="true" />
    </button>
    <div v-else class="flex items-center gap-1" :class="justifyClass">
      {{ label }}
    </div>
  </UiTooltip>
  <button
    v-else-if="sortable"
    type="button"
    :class="[buttonClass, justifyClass, sortDirection ? 'text-highlighted' : 'hover:text-default']"
    :aria-label="isHeaderEmpty ? `Sort by ${columnId}` : undefined"
    @click.stop="emit('sort', columnId)"
  >
    {{ label }}
    <UiIcon :name="sortIcon" class="size-3.5 text-dimmed transition-transform duration-150" :class="sortIconRotate" aria-hidden="true" />
  </button>
  <div v-else class="flex items-center gap-1" :class="justifyClass">
    {{ label }}
  </div>
</template>
