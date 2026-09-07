<script setup lang="ts">
import type { SemanticStatus } from '../../utils/semantic-colors.ts'
import type { UiIcon as UiIconName } from '../../utils/ui-icons.ts'

/**
 * UiSectionHeader — within-a-page section title: icon + heading, optional
 * status badge, info tooltip, description, and a trailing actions area
 * (defaults to a "View all" link when `to` is set). The nuxtseo eject targets
 * are dropped: this dashboard has no chat or MCP surface to eject into.
 */
const {
  title,
  description,
  icon,
  badge,
  badgeStatus = 'neutral',
  tooltip,
  to,
  actionLabel = 'View all',
} = defineProps<{
  title: string
  description?: string
  icon?: UiIconName
  /** Status count/label chip beside the title. */
  badge?: string | number
  badgeStatus?: SemanticStatus
  /** Info tooltip beside the title. */
  tooltip?: string
  /** Trailing "View all"-style link target. Overridden by the #actions slot. */
  to?: string
  actionLabel?: string
}>()

const slots = useSlots()
</script>

<template>
  <div data-ui="UiSectionHeader" class="mb-3 flex items-center justify-between gap-3">
    <div class="flex min-w-0 items-center gap-2">
      <UiIcon v-if="icon" :name="icon" class="size-4 shrink-0 text-dimmed" aria-hidden="true" />
      <div class="min-w-0">
        <h2 class="flex items-center gap-2 text-sm font-medium text-highlighted">
          <slot name="title">
            {{ title }}
          </slot>
          <UiChip v-if="badge != null" purpose="status" :status="badgeStatus" tabular mono>
            {{ badge }}
          </UiChip>
          <UiTooltip v-if="tooltip" :text="tooltip" trigger-as="button">
            <UiIcon name="note" class="size-3.5 text-dimmed" aria-hidden="true" />
          </UiTooltip>
          <slot name="after-title" />
        </h2>
        <p v-if="description" class="mt-0.5 text-sm leading-snug text-muted">
          {{ description }}
        </p>
      </div>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <slot v-if="slots.actions" name="actions" />
      <ULink
        v-else-if="to"
        :to="to"
        class="inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-default"
      >
        {{ actionLabel }}
        <UiIcon name="next" class="size-3.5" aria-hidden="true" />
      </ULink>
    </div>
  </div>
</template>
