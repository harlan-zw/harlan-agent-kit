<script setup lang="ts">
import type { ReservationObservation } from '../../../src/merge-reservation-observation.ts'

const { observations, generatedAt } = defineProps<{ observations: ReservationObservation[], generatedAt: string }>()
const latest = computed(() => observations[0])
const stale = computed(() => latest.value !== undefined
  && Date.parse(generatedAt) - Date.parse(latest.value.observedAt) > 6 * 60_000)
const verdicts = {
  WouldBlock: { label: 'Would block', tone: 'warning' },
  WouldAllow: { label: 'Would allow', tone: 'success' },
  WouldWait: { label: 'Would wait', tone: 'neutral' },
  WouldRelease: { label: 'Would release', tone: 'neutral' },
  Unknown: { label: 'Unknown', tone: 'neutral' },
} as const
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' })
</script>

<template>
  <details open class="group/reservation shrink-0 rounded-md border border-default bg-elevated">
    <summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
      <span>NuxtSEO reservation</span>
      <StateBadge tone="neutral" label="Observation only" />
      <UIcon name="i-octicon-chevron-right-16" class="ms-auto size-4 text-dimmed group-open/reservation:rotate-90" aria-hidden="true" />
    </summary>
    <div class="space-y-2 border-t border-default px-3 py-2 text-sm">
      <p v-if="latest === undefined" class="text-muted">
        Waiting for the first observation.
      </p>
      <template v-else>
        <p class="flex flex-wrap items-baseline gap-x-2 text-muted">
          <span v-if="latest.mainSha" class="inline-flex items-baseline gap-1">Main <code>{{ latest.mainSha.slice(0, 7) }}</code></span>
          <time :datetime="latest.observedAt">{{ date.format(new Date(latest.observedAt)) }}</time>
          <span v-if="stale">Observation is stale.</span>
        </p>
        <dl class="grid gap-2 sm:grid-cols-2">
          <div v-for="{ phase, result } in [{ phase: 'Before merge', result: latest.beforeMerge }, { phase: 'After merge', result: latest.afterMerge }]" :key="phase">
            <dt class="flex flex-wrap items-center gap-2 font-medium">
              {{ phase }}
              <StateBadge :tone="stale ? 'neutral' : verdicts[result.verdict].tone" :label="stale ? 'Unknown' : verdicts[result.verdict].label" />
            </dt>
            <dd class="mt-1 break-words text-muted">
              {{ result.reason }}
              <a v-if="result.url" class="entity-link ms-1" :href="result.url">View evidence</a>
            </dd>
          </div>
        </dl>
        <details v-if="observations.length > 1">
          <summary class="cursor-pointer text-muted">
            Recent changes
          </summary>
          <ul class="mt-1 max-h-48 divide-y divide-muted overflow-y-auto">
            <li v-for="sample in observations.slice(1)" :key="sample.observedAt" class="py-1">
              <div class="flex flex-wrap items-baseline gap-x-2 text-muted">
                <code v-if="sample.mainSha">{{ sample.mainSha.slice(0, 7) }}</code>
                <time :datetime="sample.observedAt">{{ date.format(new Date(sample.observedAt)) }}</time>
              </div>
              <p v-for="result in [sample.beforeMerge, sample.afterMerge]" :key="result.verdict + result.reason" class="flex flex-wrap items-baseline gap-x-2">
                <strong>{{ verdicts[result.verdict].label }}</strong>
                <span>{{ result.reason }}</span>
                <a v-if="result.url" class="entity-link" :href="result.url">View evidence</a>
              </p>
            </li>
          </ul>
        </details>
      </template>
    </div>
  </details>
</template>
