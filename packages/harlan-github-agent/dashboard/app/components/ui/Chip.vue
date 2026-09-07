<script setup lang="ts">
import type { SemanticStatus } from '../../utils/semantic-colors.ts'
import type { UiIcon as UiIconName } from '../../utils/ui-icons.ts'
import { semanticColors } from '../../utils/semantic-colors.ts'

/**
 * UiChip — the single chip/badge primitive, driven by a semantic `purpose`
 * prop. There is no raw `variant`/`color` knob: each purpose resolves to a
 * fixed treatment so chip intent reads consistently everywhere.
 *
 *   - `status`  semantic state (health, sync, validation). Colour comes from
 *               the data-bound `status` prop on an AA-safe neutral surface.
 *   - `count`   quantity / category metadata — neutral outline.
 *   - `tag`     low-emphasis label / removable filter — muted fill.
 *   - `accent`  standout marker (e.g. NEW) — inverted neutral.
 *   - `brand`   deliberate brand marker. This dashboard's primary is ink, so
 *               brand reads as accent here.
 */
const {
  purpose = 'status',
  status = 'neutral',
  size = 'xs',
  icon,
  removable = false,
  mono = false,
  tabular = false,
  label,
} = defineProps<{
  purpose?: 'status' | 'count' | 'tag' | 'accent' | 'brand'
  /** Semantic status — only honoured when purpose='status'. */
  status?: SemanticStatus
  size?: 'xs' | 'sm' | 'md'
  icon?: UiIconName
  removable?: boolean
  mono?: boolean
  tabular?: boolean
  /** Chip text, used to give the remove button a unique accessible name. */
  label?: string
}>()

const emit = defineEmits<{
  remove: []
}>()

// 14px floor: every size keeps text-sm and differs in padding only.
const sizeClass = {
  xs: 'text-sm/4 px-1.5 py-0.5 rounded-sm gap-1',
  sm: 'text-sm/5 px-2 py-0.5 rounded-sm gap-1.5',
  md: 'text-sm/5 px-2 py-1 rounded-sm gap-1.5',
} as const

const colorClass = computed(() => {
  switch (purpose) {
    case 'count':
      return 'border border-default bg-default text-muted'
    case 'tag':
      return 'bg-accented text-muted'
    case 'accent':
    case 'brand':
      return 'bg-inverted text-inverted'
    case 'status':
    default: {
      const c = semanticColors[status]
      return `border bg-default ${c.border} ${c.text}`
    }
  }
})
</script>

<template>
  <span
    data-ui="UiChip"
    class="inline-flex items-center whitespace-nowrap font-medium"
    :class="[
      sizeClass[size],
      colorClass,
      mono && 'font-mono',
      tabular && 'tabular-nums',
    ]"
  >
    <UiIcon v-if="icon" :name="icon" class="size-3.5 shrink-0" aria-hidden="true" />
    <slot />
    <button
      v-if="removable"
      type="button"
      class="-mr-0.5 inline-flex cursor-pointer items-center justify-center rounded-sm opacity-60 transition-opacity hover:opacity-100"
      :aria-label="label ? `Remove ${label}` : 'Remove'"
      @click.stop="emit('remove')"
    >
      <UiIcon name="close" class="size-3.5" aria-hidden="true" />
    </button>
  </span>
</template>
