<script setup lang="ts" generic="T extends object">
import { computed, onMounted, ref } from 'vue'

// Port of nuxtseo design-system UiDataList. Swaps: UiHelpLabel → UiTooltip on
// the title, UiNavIcon → UiIcon. The bar colour defaults to ink instead of the
// Pro violet.

type UiDataListRouteTarget = string | Record<string, unknown>
interface UiDataListKeyFields {
  id?: string | number
  key?: string | number
  path?: string
  url?: string
}

const {
  title,
  icon,
  iconColor,
  tooltip,
  metricLabel,
  items,
  loading,
  loadingCount = 5,
  viewMoreTo,
  viewMoreLabel = 'View all',
  emptyIcon,
  emptyText = 'No data available',
  barValue,
  barTotal,
  barColor = 'bg-inverted',
  itemTo,
  subtle = false,
} = defineProps<{
  title?: string
  icon?: string
  /** Text colour class for the icon. When set, the icon sits on a tinted pad. */
  iconColor?: string
  /** Render the title as a quieter sub-tier (muted) for nested lists. */
  subtle?: boolean
  tooltip?: string
  metricLabel?: string
  items?: T[]
  loading?: boolean
  loadingCount?: number
  viewMoreTo?: UiDataListRouteTarget
  viewMoreLabel?: string
  emptyIcon?: string
  emptyText?: string
  /** Accessor fn to get bar value from item. When set, renders a % fill bar behind each row. */
  barValue?: (item: T) => number
  /**
   * Denominator for the bar fill. Omit it (the default) and the bars are
   * max-relative: the largest row fills 100% and every other row is drawn in
   * proportion to it, so the list reads as magnitude. Pass an explicit value to
   * mean something else — `100` for rows that already hold percentages, or the
   * sum of a wider set when the bar must read as share-of-total.
   */
  barTotal?: number
  /** Bar colour class (default: ink). */
  barColor?: string
  /** Accessor fn for row link target. When set, each row becomes a NuxtLink with a trailing chevron. */
  itemTo?: (item: T) => UiDataListRouteTarget | undefined | null
}>()

defineSlots<{
  'default'?: (props: { item: T, index: number }) => unknown
  'header-trailing'?: () => unknown
  'empty'?: () => unknown
  'footer'?: () => unknown
}>()

// Treat SSR as loading to avoid hydration mismatch when data arrives client-side
const hydrated = ref(false)
onMounted(() => {
  hydrated.value = true
})
const isLoading = computed(() => loading || (!hydrated.value && !items?.length))

// Default denominator is the LARGEST row, not the sum: dividing by the sum
// squashes even a dominant row into a third of the track and renders the tail
// as slivers, so the bars carry no magnitude. An explicit `barTotal` still wins.
const computedBarTotal = computed(() => {
  if (barTotal != null)
    return barTotal
  if (!barValue || !items?.length)
    return 0
  return items.reduce((max, item) => Math.max(max, barValue!(item)), 0)
})

function barPct(item: T): number {
  if (!barValue)
    return 0
  const total = computedBarTotal.value
  return total > 0 ? (barValue(item) / total) * 100 : 0
}

const titleClass = computed(() => subtle ? 'text-sm font-medium text-muted' : 'text-sm font-medium')
const NuxtLink = resolveComponent('NuxtLink')

function itemKey(item: T, index: number): string | number {
  const row = item as UiDataListKeyFields
  return row.id ?? row.key ?? row.path ?? row.url ?? index
}
</script>

<template>
  <div class="flex flex-col" :aria-busy="isLoading">
    <!-- Header -->
    <div v-if="title || icon || $slots['header-trailing']" class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-1 pb-2.5">
      <div v-if="title || icon" class="flex items-center gap-2">
        <div v-if="icon && iconColor" class="rounded-md bg-muted p-1">
          <UiIcon :name="icon" class="size-3.5" :class="iconColor" />
        </div>
        <UiIcon v-else-if="icon" :name="icon" class="size-4 text-dimmed" aria-hidden="true" />
        <UiTooltip v-if="title && tooltip" :text="tooltip">
          <span :class="titleClass">{{ title }}</span>
        </UiTooltip>
        <span v-else-if="title" :class="titleClass">{{ title }}</span>
      </div>
      <div class="flex items-center justify-between gap-3">
        <slot name="header-trailing">
          <span v-if="metricLabel" class="text-sm text-muted">{{ metricLabel }}</span>
        </slot>
        <NuxtLink
          v-if="viewMoreTo"
          :to="viewMoreTo"
          class="group/link inline-flex min-h-11 items-center gap-1 text-sm text-muted transition-colors hover:text-default"
        >
          {{ viewMoreLabel }}
          <UiIcon name="next" class="size-3.5 transition-transform group-hover/link:translate-x-0.5" aria-hidden="true" />
        </NuxtLink>
      </div>
    </div>

    <div class="flex flex-1 flex-col overflow-hidden rounded-lg border border-default bg-elevated">
      <!-- Loading -->
      <div v-if="isLoading" class="px-3 py-3">
        <UiSkeleton type="text" :lines="loadingCount" />
      </div>

      <!-- Empty -->
      <div v-else-if="!items?.length" class="flex flex-1 flex-col items-center justify-center px-4 py-6 text-center">
        <UiIcon v-if="emptyIcon" :name="emptyIcon" class="mb-2 size-6 text-dimmed" aria-hidden="true" />
        <p class="text-sm text-dimmed">
          <slot name="empty">
            {{ emptyText }}
          </slot>
        </p>
      </div>

      <!-- Items — condensed by default. `min-h-11` keeps the 44px touch target
           on coarse pointers; from `sm` up a row floors at 32px. -->
      <div v-else class="flex-1 space-y-0.5 p-1">
        <component
          :is="itemTo && itemTo(item) ? NuxtLink : 'div'"
          v-for="(item, index) in items"
          :key="itemKey(item, index)"
          :to="itemTo ? itemTo(item) || undefined : undefined"
          class="group relative flex min-h-11 items-center gap-2 rounded-md px-2.5 py-1 transition-colors hover:bg-muted sm:min-h-8"
        >
          <div
            v-if="barValue"
            class="pointer-events-none absolute inset-y-0 left-0 rounded-md opacity-[0.06] dark:opacity-[0.1]"
            :class="barColor"
            :style="{ width: `${barPct(item)}%` }"
          />
          <div class="relative flex min-w-0 flex-1 items-center justify-between gap-2">
            <slot :item="item" :index="index" />
          </div>
          <UiIcon
            v-if="itemTo && itemTo(item)"
            name="chevron-right"
            class="size-3.5 shrink-0 text-dimmed"
            aria-hidden="true"
          />
        </component>
      </div>

      <!-- Footer -->
      <div v-if="$slots.footer && items?.length" class="px-4 pt-2 pb-3">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>
