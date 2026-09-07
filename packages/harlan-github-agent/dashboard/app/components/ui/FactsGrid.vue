<script setup lang="ts">
import type { SemanticStatus } from '../../utils/semantic-colors.ts'
import { semanticColors } from '../../utils/semantic-colors.ts'

/**
 * Port of nuxtseo design-system UiFactsGrid — the quiet definition-list facts
 * grid (label-over-value).
 *
 * Color budget: a fact's `status` renders as a calm LEADING DOT + neutral value
 * (never a tinted value), so a grid of facts can't spend the page's color budget
 * on non-events. `mono` is for IDs / hashes / raw machine strings ONLY.
 * UiHelpLabel → UiTooltip on the label.
 */

export interface FactItem {
  label: string
  value?: string | number | null
  /** Preserve the fact cell while its value is being resolved. */
  loading?: boolean
  /** Semantic status — renders a calm leading dot; never tints the value. */
  status?: SemanticStatus
  /** Mono value — IDs / hashes / raw machine strings ONLY (not URLs, not numerals). */
  mono?: boolean
  /** Span the full row (long values like a canonical URL). */
  span?: boolean
  /** Wrap long prose instead of truncating it. */
  wrap?: boolean
  /** Link the value (row-level navigation is fine; the value is not an @click). */
  to?: string
  /** Contextual help on the fact label. */
  tooltip?: string
  /** Bold title in the help tooltip. Defaults to the label. */
  tooltipTitle?: string
}

const { facts, columns = 3 } = defineProps<{
  facts: FactItem[]
  /** Max columns at sm+ (mobile is always 2). Default 3. */
  columns?: 2 | 3
}>()

const NuxtLink = resolveComponent('NuxtLink')
</script>

<template>
  <dl
    data-ui="UiFactsGrid"
    class="grid grid-cols-2 gap-x-6 gap-y-3"
    :class="columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'"
  >
    <div
      v-for="fact in facts"
      :key="fact.label"
      class="min-w-0"
      :class="fact.span ? 'col-span-full' : ''"
    >
      <dt class="field-label">
        <UiTooltip v-if="fact.tooltip" :text="fact.tooltipTitle ? `${fact.tooltipTitle}: ${fact.tooltip}` : fact.tooltip">
          <span class="inline-flex items-center gap-1">
            {{ fact.label }}
            <UiIcon name="help" class="size-3.5 opacity-50" aria-hidden="true" />
          </span>
        </UiTooltip>
        <template v-else>
          {{ fact.label }}
        </template>
      </dt>
      <dd class="mt-0.5 flex items-center gap-1.5 text-sm">
        <span
          v-if="fact.status && !fact.loading"
          class="size-1.5 shrink-0 rounded-full"
          :class="semanticColors[fact.status].dot"
          aria-hidden="true"
        />
        <UiSkeleton
          v-if="fact.loading"
          type="text"
          class="max-w-28"
        />
        <component
          :is="fact.to ? NuxtLink : 'span'"
          v-else
          :to="fact.to || undefined"
          :class="[
            fact.wrap ? 'break-words' : 'truncate',
            fact.mono ? 'font-mono text-muted' : 'text-default',
            fact.to ? 'entity-link' : '',
          ]"
          :title="fact.value != null ? String(fact.value) : undefined"
        >
          {{ fact.value ?? '—' }}
        </component>
      </dd>
    </div>
  </dl>
</template>
