<script setup lang="ts">
import { computed } from 'vue'

/** Port of nuxtseo design-system UiTablePathCell: a URL shown as its path, full URL in the tooltip. */
const {
  url,
  label,
  to,
  maxWidth = '280px',
  external = true,
} = defineProps<{
  url: string
  /** Display text. Defaults to the pathname portion of url. */
  label?: string
  /** Internal route. When set, renders NuxtLink to this route instead of an external anchor. */
  to?: string
  maxWidth?: string
  /** Show external open icon on hover/focus. Defaults to true when no internal `to` is provided. */
  external?: boolean
}>()

const NuxtLink = resolveComponent('NuxtLink')

const display = computed(() => {
  if (label)
    return label
  try {
    const u = new URL(url)
    return u.pathname + u.search
  }
  catch {
    return url
  }
})
</script>

<template>
  <UiTooltip :text="url">
    <div class="group/path inline-flex min-w-0 items-center gap-1.5">
      <component
        :is="to ? NuxtLink : 'a'"
        :to="to || undefined"
        :href="to ? undefined : url"
        :title="url"
        :target="to ? undefined : '_blank'"
        :rel="to ? undefined : 'noreferrer'"
        class="entity-link truncate text-sm text-default"
        :style="{ maxWidth }"
      >
        {{ display }}
      </component>
      <UiIcon
        v-if="external && !to"
        name="arrow-up-right"
        class="size-3.5 shrink-0 text-dimmed opacity-0 transition-opacity group-hover/path:opacity-100 group-focus-within/path:opacity-100"
        aria-hidden="true"
      />
    </div>
  </UiTooltip>
</template>
