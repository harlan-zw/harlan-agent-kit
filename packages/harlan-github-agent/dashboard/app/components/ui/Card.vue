<script setup lang="ts">
import type { VNodeChild } from 'vue'

/**
 * UiCard — the container for a titled block of content. Ported from the
 * nuxtseo design system without its squircle corners, emphasis shadow, and
 * eject menu: this dashboard draws depth with a hairline and one surface step,
 * never a shadow, and has no chat surface to eject into.
 */
const {
  size = 'md',
  flush = false,
  titleTag = 'h3',
  variant = 'default',
} = defineProps<{
  title?: string
  /** Match the card title to its page section depth. */
  titleTag?: 'h2' | 'h3' | 'h4'
  description?: string
  divided?: boolean
  /** 'default' = elevated (forms, settings). 'subtle' = the page surface (data displays, lists). */
  variant?: 'default' | 'subtle'
  /** 'xs' = tight (inline/nested). 'sm' = compact (lists, dense tables). 'md' = default. 'lg' = spacious. */
  size?: 'xs' | 'sm' | 'md' | 'lg'
  /**
   * Drop the body padding so rows sit flush to the card edges and their
   * dividers span the full width. The rows own their inset instead.
   */
  flush?: boolean
}>()

const slots = defineSlots<{
  default?: () => VNodeChild
  header?: () => VNodeChild
  actions?: () => VNodeChild
}>()

const headerClass = {
  xs: 'px-2.5 py-2',
  sm: 'px-3 py-3',
  md: 'px-4 py-3',
  lg: 'px-6 py-5',
}[size]

const bodyClass = {
  xs: 'p-2.5',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
}[size]

const bodyDividedClass = {
  xs: 'divide-y divide-default [&>*]:p-2.5',
  sm: 'divide-y divide-default [&>*]:p-3',
  md: 'divide-y divide-default [&>*]:p-4',
  lg: 'divide-y divide-default [&>*]:p-6',
}[size]

const titleClass = {
  xs: 'text-sm font-medium text-highlighted',
  sm: 'text-sm font-medium text-highlighted',
  md: 'text-sm font-medium text-highlighted',
  lg: 'text-base font-medium text-highlighted',
}[size]
</script>

<template>
  <div
    data-ui="UiCard"
    data-ui-card
    class="relative flex flex-col overflow-hidden rounded-lg border border-default"
    :class="variant === 'subtle' ? 'bg-default' : 'bg-elevated'"
  >
    <!-- Header slot -->
    <div v-if="slots.header" class="relative shrink-0 border-b border-default" :class="headerClass">
      <slot name="header" />
    </div>
    <!-- Auto header from title/description -->
    <div v-else-if="title || slots.actions" class="relative flex shrink-0 flex-col items-stretch gap-3 border-b border-default sm:flex-row sm:items-start sm:justify-between" :class="headerClass">
      <div class="min-w-0">
        <component :is="titleTag" v-if="title" class="break-words" :class="titleClass">
          {{ title }}
        </component>
        <p v-if="description" class="mt-1 text-sm text-muted">
          {{ description }}
        </p>
      </div>
      <div v-if="slots.actions" class="flex flex-wrap items-center justify-end gap-1 sm:shrink-0">
        <slot name="actions" />
      </div>
    </div>

    <div
      data-card-body
      class="relative flex flex-1 flex-col"
      :class="[flush ? '' : divided ? bodyDividedClass : bodyClass]"
    >
      <slot />
    </div>
  </div>
</template>
