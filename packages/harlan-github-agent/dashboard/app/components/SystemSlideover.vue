<script setup lang="ts">
import type { AgentActivityItem } from '../../../src/types.ts'
import {
  activeProviderCircuits,
  incidentKindLabel,
  incidentRecoveryLabel,
  incidentScopeLabel,
  incidentUrl,
  routineReportPending,
  routineRunPresentation,
  routineTrackingUrl,
  scheduledRoutineRecords,
} from '../utils/dashboard.ts'
import {
  formatHogwildLoad,
  formatHogwildServiceMetrics,
  formatHogwildTemperature,
} from '../utils/hogwild-status.ts'
import { hostTasks } from '../utils/host-tasks.ts'
import { batchRow, capacityRow, circuitNotice, nextRoutineInstant, serviceUpdatePresentation } from '../utils/system.ts'
import HostWork from './system/HostWork.vue'

/**
 * Reference material behind one chip: Capacity, Incidents, Routines, Host.
 *
 * Nothing here acts on a Task. Watch logs and Eject live on the running card.
 */
const { snapshot, incidents, relativeTime, now, requestUpdate, controlPending, setAgentSlots } = useDashboard()
const { open } = useSystemPane()
const { connection: host, history: hostHistory } = useHogwildStatus()

const capacity = computed(() => snapshot.value.providerCapacities.map(capacityRow))
const circuits = computed(() => activeProviderCircuits(snapshot.value.providerCircuits).flatMap(circuit => circuitNotice(circuit) ?? []))
const update = computed(() => serviceUpdatePresentation(snapshot.value.serviceUpdate))
const updatePending = computed(() => snapshot.value.restartRequest?._tag === 'Requested' || snapshot.value.restartRequest?._tag === 'Restarting')

/** Coarse clock, so the next instant is not recomputed every second. */
const minute = computed(() => Math.floor(now.value.getTime() / 60_000))

const routines = computed(() => {
  const from = new Date(minute.value * 60_000)
  const writes = new Map(snapshot.value.repositories.map(repository => [repository.github, repository.writesEnabled]))
  return scheduledRoutineRecords(snapshot.value.routines, snapshot.value.routineRuns).map((record) => {
    const presentation = routineRunPresentation(record.latestRun)
    return {
      ...record,
      label: presentation.label,
      tone: presentation.tone === 'primary' ? 'neutral' as const : presentation.tone,
      detail: presentation.detail,
      trackingUrl: routineTrackingUrl(record.routine),
      next: nextRoutineInstant(record.routine, from)?.toISOString() ?? null,
      reportPending: record.latestRun !== undefined
        && routineReportPending(record.latestRun, writes.get(record.routine.repository) ?? false, record.latestRun.reportState === 'Published'),
    }
  })
})

/**
 * Agent slots are Harlan's number, and host memory is advice under it.
 *
 * The count applies to the next turn, so nothing here stops a running Agent.
 */
const slotLimits = computed(() => snapshot.value.agentSlots)
const hogwildSlots = computed(() => snapshot.value.hostCapacity?.localMaximum)
const desktopSlots = computed(() => snapshot.value.hostCapacity?.desktopMaximum)
const slotChoices = (ceiling: number): number[] => Array.from({ length: ceiling + 1 }, (_value, count) => count)
const memoryAdvice = computed(() => {
  const limits = slotLimits.value
  if (limits === undefined)
    return null
  return `Host memory suggests ${limits.hogwildMemoryMaximum} at ${limits.memoryPerAgentGiB} GiB for each Agent.`
})
const overMemory = computed(() => slotLimits.value !== undefined && hogwildSlots.value !== undefined && hogwildSlots.value > slotLimits.value.hogwildMemoryMaximum)

const hostStatus = computed(() => host.value._tag === 'Connected' ? host.value.status : undefined)
const desktopMemory = ref(16)
const capacityPending = ref(false)
const capacityMessage = ref('')
watch(() => snapshot.value.desktop?.report?.memoryGiB, (value) => {
  if (value !== undefined && !capacityPending.value)
    desktopMemory.value = value
}, { immediate: true })
const desktopReport = computed(() => snapshot.value.desktop?.connected ? snapshot.value.desktop.report : null)
const hogwildTasks = computed(() => hostTasks(snapshot.value, 'hogwild'))
const desktopTasks = computed(() => hostTasks(snapshot.value, 'desktop'))
const hogwildRunningJobs = computed(() => {
  const runners = hostStatus.value?.runners
  return runners?._tag === 'Available' && now.value.getTime() - runners.updatedAt < 30_000
    ? runners.jobs ?? { _tag: 'Unavailable' as const }
    : { _tag: 'Unavailable' as const }
})
const runnerPools = computed(() => hostStatus.value?.runners._tag === 'Available' ? hostStatus.value.runners.pools : undefined)
const hogwildJobs = computed(() => runnerPools.value?.reduce((total, pool) => total + pool.running, 0))
const hogwildQueued = computed(() => runnerPools.value?.every(pool => pool.queue._tag === 'Available')
  ? runnerPools.value.reduce((total, pool) => total + (pool.queue._tag === 'Available' ? pool.queue.jobs : 0), 0)
  : undefined)

async function saveDesktopMemory(): Promise<void> {
  if (!Number.isInteger(desktopMemory.value) || desktopMemory.value < 1 || desktopMemory.value > 256) {
    capacityMessage.value = 'Enter a whole number from 1 to 256 GiB.'
    return
  }
  capacityPending.value = true
  capacityMessage.value = ''
  await $fetch('/api/desktop/capacity', { method: 'POST', body: { memoryGiB: desktopMemory.value } })
    .then(() => { capacityMessage.value = 'Saved. Current work finishes within its existing limits.' })
    .catch(() => { capacityMessage.value = 'Could not save desktop memory. Try again.' })
    .finally(() => { capacityPending.value = false })
}

const batches = computed(() => snapshot.value.batches.map(batchRow))

function activityLine(item: AgentActivityItem): string {
  switch (item._tag) {
    case 'Command': return `$ ${item.command}${item.exitCode !== null && item.exitCode !== 0 ? ` (exit ${item.exitCode})` : ''}${item.output.length > 0 ? `\n${item.output}` : ''}`
    case 'FileChange': return `edited ${item.changes.map(change => change.path).join(', ')}`
    case 'Progress': return item.text

    case 'Reasoning': return item.text
  }
}
</script>

<template>
  <USlideover v-model:open="open" title="System" :ui="{ body: 'space-y-10' }">
    <template #body>
      <section aria-labelledby="system-execution">
        <h3 id="system-execution" class="field-label flex items-center gap-2">
          Hosts
          <span class="h-px flex-1 bg-border" aria-hidden="true" />
        </h3>
        <p class="mt-2 text-sm text-muted">
          Hogwild takes work first. Desktop helps only when Hogwild has no capacity for queued work.
        </p>
        <div class="mt-4 divide-y divide-default border-y border-default">
          <div class="py-4">
            <div class="flex items-center justify-between gap-3">
              <h4 class="font-medium">
                Hogwild
              </h4>
              <StateBadge tone="neutral" label="Primary" />
            </div>
            <dl class="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt class="text-muted">
                  Agents
                </dt><dd class="mt-1 font-mono">
                  {{ snapshot.hostCapacity ? `${snapshot.hostCapacity.localActive} / ${snapshot.hostCapacity.localMaximum}` : 'Unavailable' }}
                </dd>
              </div>
              <div>
                <dt class="text-muted">
                  GitHub Actions
                </dt><dd class="mt-1 font-mono">
                  {{ hogwildJobs === undefined ? 'Unavailable' : `${hogwildJobs} running` }}
                </dd>
              </div>
            </dl>
            <p v-if="hogwildQueued !== undefined" class="mt-2 text-xs text-muted">
              {{ hogwildQueued }} GitHub Actions jobs queued
            </p>
            <div v-if="slotLimits && hogwildSlots !== undefined" class="mt-4">
              <span id="hogwild-slots-label" class="field-label">Agent slots</span>
              <div class="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-labelledby="hogwild-slots-label">
                <UButton
                  v-for="count in slotChoices(slotLimits.hogwildCeiling)"
                  :key="count"
                  size="sm"
                  class="font-mono"
                  :color="count === hogwildSlots ? 'primary' : 'neutral'"
                  :variant="count === hogwildSlots ? 'solid' : 'outline'"
                  :aria-pressed="count === hogwildSlots"
                  :aria-label="`${count} Agent slots on Hogwild`"
                  :disabled="controlPending"
                  @click="setAgentSlots('hogwild', count)"
                >
                  {{ count }}
                </UButton>
              </div>
              <p class="mt-2 text-xs" :class="overMemory ? 'status-warning' : 'text-muted'">
                {{ memoryAdvice }}<template v-if="overMemory">
                  Hogwild may run out of memory.
                </template>
              </p>
            </div>
            <HostWork :tasks="hogwildTasks" :tasks-available="snapshot.hostTasks !== undefined" :jobs="hogwildRunningJobs" />
          </div>
          <div class="py-4">
            <div class="flex items-center justify-between gap-3">
              <h4 class="font-medium">
                Desktop
              </h4>
              <StateBadge :tone="desktopReport ? 'neutral' : 'warning'" :label="!desktopReport ? 'Disconnected' : desktopReport.agents + desktopReport.actions > 0 ? 'Helping Hogwild' : 'Idle'" />
            </div>
            <template v-if="desktopReport">
              <dl class="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt class="text-muted">
                    Agents
                  </dt><dd class="mt-1 font-mono">
                    {{ desktopSlots === undefined ? `${desktopReport.agents} running` : `${desktopReport.agents} / ${desktopSlots}` }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    GitHub Actions
                  </dt><dd class="mt-1 font-mono">
                    {{ desktopReport.actions }} running
                  </dd>
                </div>
              </dl>
              <div class="mt-4 flex items-center justify-between gap-2 text-sm">
                <span class="text-muted">Memory committed</span>
                <span class="font-mono">{{ desktopReport.reservedGiB }} / {{ desktopReport.memoryGiB }} GiB</span>
              </div>
              <UProgress class="mt-2" :model-value="desktopReport.reservedGiB" :max="desktopReport.memoryGiB" aria-label="Desktop memory committed" />
              <HostWork :tasks="desktopTasks" :tasks-available="snapshot.hostTasks !== undefined" :jobs="desktopReport.jobs ?? { _tag: 'Unavailable' }" />
            </template>
            <p v-else class="mt-3 text-sm text-muted">
              Desktop takes no new work until it reconnects.
            </p>
            <div v-if="slotLimits && desktopSlots !== undefined" class="mt-4">
              <span id="desktop-slots-label" class="field-label">Agent slots</span>
              <div class="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-labelledby="desktop-slots-label">
                <UButton
                  v-for="count in slotChoices(slotLimits.desktopCeiling)"
                  :key="count"
                  size="sm"
                  class="font-mono"
                  :color="count === desktopSlots ? 'primary' : 'neutral'"
                  :variant="count === desktopSlots ? 'solid' : 'outline'"
                  :aria-pressed="count === desktopSlots"
                  :aria-label="`${count} Agent slots on the desktop`"
                  :disabled="controlPending"
                  @click="setAgentSlots('desktop', count)"
                >
                  {{ count }}
                </UButton>
              </div>
              <p class="mt-2 text-xs text-muted">
                Zero keeps every Agent on Hogwild. Each desktop Agent needs {{ slotLimits.memoryPerAgentGiB }} GiB.
              </p>
            </div>
            <form class="mt-4" @submit.prevent="saveDesktopMemory">
              <label for="desktop-memory" class="field-label">Desktop memory, shared by both queues</label>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <UInput id="desktop-memory" v-model.number="desktopMemory" type="number" :min="1" :max="256" :step="1" class="w-24" aria-describedby="desktop-memory-help" />
                <span class="text-sm text-muted">GiB</span>
                <UButton type="submit" color="neutral" variant="outline" :loading="capacityPending">
                  Save
                </UButton>
              </div>
              <p id="desktop-memory-help" class="mt-2 text-xs text-muted">
                Each desktop Agent needs 8 GiB. GitHub Actions jobs use their container limits.
              </p>
              <p v-if="capacityMessage" role="status" class="mt-2 text-sm">
                {{ capacityMessage }}
              </p>
              <p v-if="snapshot.desktop?.requestedMemoryGiB" class="mt-2 text-xs text-muted">
                {{ snapshot.desktop.requestedMemoryGiB }} GiB will apply when the desktop next connects.
              </p>
            </form>
          </div>
        </div>
      </section>

      <section aria-labelledby="system-service">
        <h3 id="system-service" class="field-label flex items-center gap-2">
          Service
          <span class="h-px flex-1 bg-border" aria-hidden="true" />
        </h3>
        <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
          <StateBadge :tone="update.tone" :label="update.label" />
          <UButton
            v-if="snapshot.serviceUpdate._tag === 'Available'"
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-octicon-sync-16"
            :disabled="controlPending || updatePending"
            @click="requestUpdate"
          >
            Update after current work
          </UButton>
        </div>
        <dl class="mt-3 divide-y divide-default border-t border-default">
          <div class="flex items-center justify-between gap-4 py-2.5">
            <dt class="field-label">
              Deployed commit
            </dt>
            <dd class="break-all font-mono text-sm text-muted">
              {{ update.deployedCommit || 'Unknown' }}
            </dd>
          </div>
          <div v-if="update.latestCommit" class="flex items-center justify-between gap-4 py-2.5">
            <dt class="field-label">
              Latest commit
            </dt>
            <dd class="break-all font-mono text-sm text-muted">
              {{ update.latestCommit }}
            </dd>
          </div>
          <div class="flex items-center justify-between gap-4 py-2.5">
            <dt class="field-label">
              Last checked
            </dt>
            <dd class="text-sm text-muted">
              {{ update.checkedAt ? relativeTime(update.checkedAt) : 'Checking now' }}
            </dd>
          </div>
        </dl>
        <p v-if="update.detail" class="mt-2 text-sm status-warning">
          {{ update.detail }}
        </p>
      </section>

      <section aria-labelledby="system-capacity">
        <h3 id="system-capacity" class="field-label flex items-center gap-2">
          Capacity
          <span class="h-px flex-1 bg-border" aria-hidden="true" />
        </h3>
        <ul v-if="capacity.length > 0" class="mt-1 divide-y divide-default">
          <li v-for="row in capacity" :key="row.provider" class="py-2.5">
            <div class="flex items-baseline justify-between gap-3">
              <span class="text-sm text-highlighted">{{ row.name }}</span>
              <span class="font-mono text-sm" :class="row.tone === 'warning' ? 'status-warning' : undefined">{{ row.value }}</span>
            </div>
            <p class="mt-0.5 text-sm text-muted">
              {{ row.detail }}<template v-if="row.resetsAt">
                · resets {{ relativeTime(row.resetsAt) }}
              </template>
            </p>
          </li>
        </ul>
        <p v-else class="mt-2 text-sm text-muted">
          No Agent provider limit reported.
        </p>
        <p v-for="notice in circuits" :key="notice.text" class="mt-2 text-sm status-warning">
          {{ notice.text }}<template v-if="notice._tag === 'Open'">
            Retry {{ relativeTime(notice.retryAt) }}.
          </template>
        </p>
      </section>

      <section aria-labelledby="system-incidents">
        <h3 id="system-incidents" class="field-label flex items-center gap-2">
          Incidents
          <span class="h-px flex-1 bg-border" aria-hidden="true" />
        </h3>
        <ul v-if="incidents.length > 0" class="mt-1 divide-y divide-default">
          <li v-for="incident in incidents" :key="incident.id" class="space-y-1 py-3">
            <div class="flex flex-wrap items-center gap-2">
              <StateBadge :tone="incident.severity" :label="incidentKindLabel(incident)" />
              <a v-if="incidentUrl(incident)" :href="incidentUrl(incident)" target="_blank" rel="noreferrer" class="entity-link text-sm">{{ incidentScopeLabel(incident) }}</a>
              <span v-else class="text-sm">{{ incidentScopeLabel(incident) }}</span>
            </div>
            <p class="text-sm">
              {{ incident.message }}
            </p>
            <p class="text-sm text-muted">
              {{ incidentRecoveryLabel(incident) }} · <span class="font-mono">{{ incident.occurrences }}×</span> · {{ relativeTime(incident.firstSeenAt) }}
            </p>
          </li>
        </ul>
        <p v-else class="mt-2 text-sm text-muted">
          No Incidents.
        </p>
      </section>

      <section v-if="batches.length > 0" aria-labelledby="system-batches">
        <h3 id="system-batches" class="field-label flex items-center gap-2">
          Batches
          <span class="h-px flex-1 bg-border" aria-hidden="true" />
        </h3>
        <ul class="mt-1 divide-y divide-default">
          <li v-for="batch in batches" :key="batch.id" class="space-y-1 py-3">
            <div class="flex flex-wrap items-center gap-2">
              <RepositoryIdentity :repository="batch.repository" class="font-mono text-sm text-highlighted" />
              <span class="font-mono text-sm text-muted">{{ batch.issues }}</span>
              <StateBadge :tone="batch.tone" :label="batch.label" class="ms-auto" />
            </div>
            <p class="text-sm text-muted">
              Opened {{ relativeTime(batch.createdAt) }}. One permit.
            </p>
            <p v-if="batch.reason" class="text-sm status-warning">
              {{ batch.reason }}
            </p>
            <ul v-if="batch.units.length > 0" class="mt-1 space-y-1.5">
              <li v-for="unit in batch.units" :key="unit.id" class="rounded-md border border-default p-2.5 text-sm">
                <div class="flex flex-wrap items-center gap-2">
                  <a
                    v-if="unit.pullRequestNumber !== null"
                    :href="`https://github.com/${batch.repository}/pull/${unit.pullRequestNumber}`"
                    target="_blank"
                    rel="noreferrer"
                    class="entity-link font-mono"
                  >{{ unit.issues }}</a>
                  <span v-else class="font-mono">{{ unit.issues }}</span>
                  <span v-if="unit.stack" class="font-mono text-muted">{{ unit.stack }}</span>
                  <StateBadge :tone="unit.tone" :label="unit.label" class="ms-auto" />
                </div>
                <p v-if="unit.rationale" class="mt-1 text-muted">
                  {{ unit.rationale }}
                </p>
              </li>
            </ul>
          </li>
        </ul>
      </section>

      <section v-if="routines.length > 0" aria-labelledby="system-routines">
        <h3 id="system-routines" class="field-label flex items-center gap-2">
          Routines
          <span class="h-px flex-1 bg-border" aria-hidden="true" />
        </h3>
        <ul class="mt-1 divide-y divide-default">
          <li v-for="record in routines" :key="record.routine.id" class="space-y-1 py-3">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-mono text-sm text-highlighted">{{ record.routine.name }}</span>
              <a
                v-if="record.trackingUrl"
                :href="record.trackingUrl"
                target="_blank"
                rel="noreferrer"
                class="entity-link font-mono text-sm text-muted"
              ><RepositoryIdentity :repository="record.routine.repository"> #{{ record.routine.trackingIssueNumber }}</RepositoryIdentity></a>
              <RepositoryIdentity v-else :repository="record.routine.repository" class="font-mono text-sm text-muted" />
              <StateBadge :tone="record.tone" :label="record.label" class="ms-auto" />
            </div>
            <p class="text-sm text-muted">
              <template v-if="!record.routine.enabled">
                Disabled.
              </template>
              <template v-else>
                <template v-if="record.routine.lastRunAt">
                  Last {{ relativeTime(record.routine.lastRunAt) }}.
                </template>
                <template v-if="record.next">
                  Next {{ relativeTime(record.next) }}.
                </template>
              </template>
            </p>
            <p v-if="record.detail" class="text-sm">
              {{ record.detail }}
            </p>
            <p v-if="record.reportPending" class="text-sm status-warning">
              Report pending. <NuxtLink to="/watching" class="entity-link">
                Enable writes in Watching.
              </NuxtLink>
            </p>
            <details v-if="record.latestRun && record.latestRun.candidates.length > 0" class="text-sm">
              <summary class="cursor-pointer text-muted">
                {{ record.latestRun.candidates.length }} {{ record.latestRun.candidates.length === 1 ? 'candidate' : 'candidates' }}
              </summary>
              <ul class="mt-2 space-y-2">
                <li v-for="candidate in record.latestRun.candidates" :key="candidate.id" class="rounded-md border border-default p-3">
                  <p>{{ candidate.claim }}</p>
                  <p class="mt-1 break-all font-mono text-sm text-muted">
                    {{ candidate.target }}
                  </p>
                </li>
              </ul>
            </details>
            <details v-if="record.latestRun && record.latestRun.activity.length > 0" class="text-sm">
              <summary class="cursor-pointer text-muted">
                Terminal
              </summary>
              <pre class="terminal mt-2">{{ record.latestRun.activity.map(activityLine).join('\n') }}</pre>
            </details>
          </li>
        </ul>
      </section>

      <section v-if="host._tag !== 'NotOnHogwild'" aria-labelledby="system-host">
        <h3 id="system-host" class="field-label flex items-center gap-2">
          Host
          <span class="h-px flex-1 bg-border" aria-hidden="true" />
        </h3>
        <template v-if="hostStatus">
          <dl class="mt-1 divide-y divide-default">
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
              <dt class="field-label w-24">
                Temperature
              </dt>
              <dd v-if="hostStatus.temperatures._tag === 'Available'" class="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span
                  v-for="temperature in hostStatus.temperatures.values"
                  :key="temperature.name"
                  class="inline-flex items-center gap-2 font-mono text-sm text-muted"
                >
                  {{ formatHogwildTemperature(temperature) }}
                  <Sparkline :data="hostHistory.temperatures[temperature.name]" :label="`${temperature.name} temperature in °C`" />
                </span>
              </dd>
              <dd v-else class="font-mono text-sm text-muted">
                Unavailable
              </dd>
            </div>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
              <dt class="field-label w-24">
                Load
              </dt>
              <dd class="inline-flex items-center gap-2 font-mono text-sm text-muted">
                {{ formatHogwildLoad(hostStatus.load) }}
                <Sparkline :data="hostHistory.load" label="One minute load average" />
              </dd>
            </div>
          </dl>
          <ul class="mt-4 divide-y divide-default border-t border-default">
            <li v-for="service in hostStatus.services" :key="service.name" class="py-2.5">
              <div class="flex items-baseline justify-between gap-3">
                <span class="text-sm">{{ service.name }}</span>
                <span class="font-mono text-sm" :class="service.state._tag === 'Active' ? 'status-success' : 'status-warning'">{{ service.state._tag }}</span>
              </div>
              <div v-if="service.state._tag === 'Active'" class="mt-1 flex flex-wrap items-center justify-between gap-2">
                <span class="font-mono text-sm text-muted">{{ formatHogwildServiceMetrics(service.state.metrics) }}</span>
                <Sparkline :data="hostHistory.serviceMemoryMb[service.name]" :label="`${service.name} memory in MB`" />
              </div>
            </li>
          </ul>
        </template>
        <p v-else class="mt-2 text-sm text-muted">
          {{ host._tag === 'Connecting' ? 'Waiting for host status.' : host._tag === 'Unavailable' ? host.reason : '' }}
        </p>
      </section>
    </template>
  </USlideover>
</template>
