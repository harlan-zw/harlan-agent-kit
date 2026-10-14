<script setup lang="ts">
import type { RepairRecoveryRequest } from '../../../src/repair-recovery.ts'
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
  hogwildStatusFresh,
} from '../utils/hogwild-status.ts'
import { hostTasks } from '../utils/host-tasks.ts'
import {
  batchRow,
  capacityRow,
  circuitNotice,
  desktopPresentation,
  nextRoutineInstant,
  retryDeadline,
  serviceUpdatePresentation,
} from '../utils/system.ts'
import GitHubRateLimits from './system/GitHubRateLimits.vue'
import HostWork from './system/HostWork.vue'

/**
 * Reference material behind one chip: Capacity, Incidents, Routines, Host.
 *
 * Watch logs opens Sessions from the running Agent. Retained Repairs offer inspection here.
 */
const {
  snapshot,
  incidents,
  relativeTime,
  now,
  requestUpdate,
  controlPending,
  controlsUnavailable,
  loadState,
  loadError,
  setAgentSlots,
} = useDashboard()
const { open } = useSystemPane()
const recoveryOpen = ref(false)
const recoveryCandidate = ref<Extract<RepairRecoveryRequest, { _tag: 'Plan' }> | null>(null)
function inspectRecovery(candidate: Extract<RepairRecoveryRequest, { _tag: 'Plan' }>): void {
  recoveryCandidate.value = { _tag: 'Plan', taskId: candidate.taskId, commitSha: candidate.commitSha }
  open.value = false
  recoveryOpen.value = true
}
const { connection: host, history: hostHistory } = useHogwildStatus()
const incidentLimit = ref(50)
const visibleIncidents = computed(() => incidents.value.slice(0, incidentLimit.value))
const desktopState = computed(() => desktopPresentation(snapshot.value.desktop, !controlsUnavailable.value))

const capacity = computed(() => snapshot.value.providerCapacities.map(capacityRow))
const circuits = computed(() =>
  activeProviderCircuits(snapshot.value.providerCircuits).flatMap((circuit) => circuitNotice(circuit) ?? []),
)
const triageSummary = computed(() => {
  const decisions = snapshot.value.triageDecisions
  const parts = [`${decisions.reviewSkipped} skipped`, `${decisions.reviewRequired} sent to Review`]
  if (decisions.couldNotDecide > 0) parts.push(`${decisions.couldNotDecide} could not decide`)
  return parts.join(', ')
})
const update = computed(() => serviceUpdatePresentation(snapshot.value.serviceUpdate))
const updatePending = computed(
  () => snapshot.value.restartRequest?._tag === 'Requested' || snapshot.value.restartRequest?._tag === 'Restarting',
)

/** Coarse clock, so the next instant is not recomputed every second. */
const minute = computed(() => Math.floor(now.value.getTime() / 60_000))

const routines = computed(() => {
  const from = new Date(minute.value * 60_000)
  const writes = new Map(snapshot.value.repositories.map((repository) => [repository.github, repository.writesEnabled]))
  return scheduledRoutineRecords(snapshot.value.routines, snapshot.value.routineRuns).map((record) => {
    const presentation = routineRunPresentation(record.latestRun)
    return {
      ...record,
      label: presentation.label,
      tone: presentation.tone === 'primary' ? ('neutral' as const) : presentation.tone,
      detail: presentation.detail,
      trackingUrl: routineTrackingUrl(record.routine),
      next: nextRoutineInstant(record.routine, from)?.toISOString() ?? null,
      reportPending:
        record.latestRun !== undefined &&
        routineReportPending(
          record.latestRun,
          writes.get(record.routine.repository) ?? false,
          record.latestRun.reportState === 'Published',
        ),
    }
  })
})

/**
 * Agent slots are Wolfstar's number, and host memory is advice under it.
 *
 * The count applies to the next turn, so nothing here stops a running Agent.
 */
const slotLimits = computed(() => snapshot.value.agentSlots)
const hogwildSlots = computed(() => snapshot.value.hostCapacity?.localMaximum)
const desktopSlots = computed(() => snapshot.value.hostCapacity?.desktopMaximum)
const slotChoices = (ceiling: number): number[] => Array.from({ length: ceiling + 1 }, (_value, count) => count)
const memoryAdvice = computed(() => {
  const limits = slotLimits.value
  if (limits === undefined) return null
  return `Host memory suggests ${limits.hogwildMemoryMaximum} at ${limits.memoryPerAgentGiB} GiB for each Agent.`
})
const overMemory = computed(
  () =>
    slotLimits.value !== undefined &&
    hogwildSlots.value !== undefined &&
    hogwildSlots.value > slotLimits.value.hogwildMemoryMaximum,
)

const hostStatus = computed(() => (host.value._tag === 'Connected' ? host.value.status : undefined))
const desktopReport = computed(() => desktopState.value.report)
const hogwildTasks = computed(() => hostTasks(snapshot.value, 'hogwild'))
const desktopTasks = computed(() => hostTasks(snapshot.value, 'desktop'))
const hogwildRunningJobs = computed(() => {
  const runners = hostStatus.value?.runners
  return runners?._tag === 'Available' && hogwildStatusFresh(runners.updatedAt, now.value)
    ? (runners.jobs ?? { _tag: 'Unavailable' as const })
    : { _tag: 'Unavailable' as const }
})
const runnerPools = computed(() => {
  const runners = hostStatus.value?.runners
  return runners?._tag === 'Available' && hogwildStatusFresh(runners.updatedAt, now.value) ? runners.pools : undefined
})
const hogwildJobs = computed(() => runnerPools.value?.reduce((total, pool) => total + pool.running, 0))
const hogwildQueued = computed(() =>
  runnerPools.value?.every((pool) => pool.queue._tag === 'Available')
    ? runnerPools.value.reduce((total, pool) => total + (pool.queue._tag === 'Available' ? pool.queue.jobs : 0), 0)
    : undefined,
)

const batches = computed(() => snapshot.value.batches.map(batchRow))
const healthEntries = computed(() => {
  if (controlsUnavailable.value) return []
  const entries: Array<{
    key: string
    label: string
    detail: string
    target: string
    tone: 'error' | 'warning'
    at: string | null
  }> = []
  if (incidents.value.length > 0) {
    const first = incidents.value[0]!
    entries.push({
      key: 'incidents',
      label: `${incidents.value.length} ${incidents.value.length === 1 ? 'Incident' : 'Incidents'}`,
      detail: first.message,
      target: 'system-incidents',
      tone: first.severity,
      at: first.lastSeenAt,
    })
  }
  if (snapshot.value.repairRecoveryCandidates.length > 0)
    entries.push({
      key: 'repair',
      label: 'Repair recovery',
      detail: `${snapshot.value.repairRecoveryCandidates.length} retained ${snapshot.value.repairRecoveryCandidates.length === 1 ? 'Repair needs' : 'Repairs need'} inspection.`,
      target: 'system-repair-recovery',
      tone: 'error',
      at: null,
    })
  if (snapshot.value.serviceUpdate._tag === 'Unavailable')
    entries.push({
      key: 'update',
      label: 'Service update unavailable',
      detail: snapshot.value.serviceUpdate.reason,
      target: 'system-service',
      tone: 'warning',
      at: snapshot.value.serviceUpdate.checkedAt,
    })
  if (snapshot.value.desktop?.connected && !snapshot.value.desktop.current)
    entries.push({
      key: 'desktop',
      label: 'Desktop update required',
      detail: desktopState.value.detail,
      target: 'system-desktop',
      tone: 'warning',
      at: null,
    })
  for (const notice of circuits.value)
    entries.push({
      key: notice.text,
      label: 'Agent provider',
      detail: notice.text,
      target: 'system-capacity',
      tone: 'warning',
      at: null,
    })
  if (snapshot.value.agentStart._tag !== 'Available')
    entries.push({
      key: 'start',
      label: 'Agents cannot start',
      detail:
        snapshot.value.agentStart._tag === 'Paused'
          ? 'Paused. Resume from the header.'
          : snapshot.value.agentStart._tag === 'ReserveReached'
            ? 'Reserve reached. Check Capacity.'
            : 'Check Capacity and Service settings.',
      target: snapshot.value.agentStart._tag === 'RestartRequested' ? 'system-service' : 'system-capacity',
      tone: 'warning',
      at: null,
    })
  if (host.value._tag === 'Stale' || host.value._tag === 'Unavailable')
    entries.push({
      key: 'host',
      label: 'Host data unavailable',
      detail:
        host.value._tag === 'Stale'
          ? 'Host updates stopped. Counts and service states are unavailable.'
          : host.value.reason,
      target: 'system-host',
      tone: 'warning',
      at: host.value._tag === 'Stale' ? new Date(host.value.updatedAt).toISOString() : null,
    })
  for (const service of hostStatus.value?.services ?? []) {
    if (service.state._tag !== 'Active')
      entries.push({
        key: service.name,
        label: service.name,
        detail: `Service state: ${service.state._tag}. Check Host details.`,
        target: 'system-host',
        tone: 'warning',
        at: new Date(hostStatus.value!.updatedAt).toISOString(),
      })
  }
  return entries.sort((a, b) => Number(a.tone === 'warning') - Number(b.tone === 'warning'))
})

function activityLine(item: AgentActivityItem): string {
  switch (item._tag) {
    case 'Command':
      return `$ ${item.command}${item.exitCode !== null && item.exitCode !== 0 ? ` (exit ${item.exitCode})` : ''}${item.output.length > 0 ? `\n${item.output}` : ''}`
    case 'FileChange':
      return `edited ${item.changes.map((change) => change.path).join(', ')}`
    case 'Progress':
      return item.text

    case 'Reasoning':
      return item.text
  }
}
</script>

<template>
  <USlideover v-model:open="open" title="System" :ui="{ body: 'space-y-10 wrap-anywhere' }">
    <template #body>
      <section v-if="controlsUnavailable" role="status" aria-label="Service data unavailable">
        <p class="text-sm status-warning">Service data is unavailable. Reload before changing settings or work.</p>
        <p v-if="snapshot.generatedAt" class="mt-2 text-sm text-muted">
          Last update {{ relativeTime(snapshot.generatedAt) }}.
        </p>
        <p v-if="loadError" class="mt-2 text-sm status-error">
          {{ loadError }}
        </p>
        <UButton class="mt-3" color="neutral" variant="outline" @click="loadState"> Reload </UButton>
      </section>
      <template v-else>
        <section v-if="healthEntries.length > 0" aria-labelledby="system-health" aria-live="polite">
          <h3 id="system-health" class="field-label">System</h3>
          <ul class="mt-2 divide-y divide-default">
            <li v-for="entry in healthEntries" :key="entry.key" class="py-2">
              <a
                :href="`#${entry.target}`"
                class="entity-link text-sm"
                :class="entry.tone === 'error' ? 'status-error' : 'status-warning'"
                >{{ entry.label }}</a
              >
              <p class="mt-1 text-sm break-words">
                {{ entry.detail }}
              </p>
              <p v-if="entry.at" class="mt-1 text-xs text-muted">Last seen {{ relativeTime(entry.at) }}.</p>
            </li>
          </ul>
        </section>
        <section class="lg:hidden" aria-label="Agent selection">
          <AgentSelectionMenu />
        </section>
        <GitHubRateLimits />
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
                <h4 class="font-medium">Hogwild</h4>
                <StateBadge tone="neutral" label="Primary" />
              </div>
              <dl class="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt class="text-muted">Agents</dt>
                  <dd class="mt-1 font-mono">
                    {{
                      snapshot.hostCapacity
                        ? `${snapshot.hostCapacity.localActive} / ${snapshot.hostCapacity.localMaximum}`
                        : 'Unavailable'
                    }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">GitHub Actions</dt>
                  <dd class="mt-1 font-mono">
                    {{ hogwildJobs === undefined ? 'Unavailable' : `${hogwildJobs} running` }}
                  </dd>
                </div>
              </dl>
              <p v-if="hogwildQueued !== undefined" class="mt-2 text-xs text-muted">
                {{ hogwildQueued }} GitHub Actions jobs queued
              </p>
              <div v-if="slotLimits && hogwildSlots !== undefined" class="mt-4">
                <span id="hogwild-slots-label" class="field-label">Agent slots</span>
                <div
                  class="mt-2 flex flex-wrap items-center gap-1.5"
                  role="group"
                  aria-labelledby="hogwild-slots-label"
                >
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
                  {{ memoryAdvice }}<template v-if="overMemory"> Hogwild may run out of memory. </template>
                </p>
              </div>
              <HostWork
                :tasks="hogwildTasks"
                :tasks-available="snapshot.hostTasks !== undefined"
                :jobs="hogwildRunningJobs"
              />
            </div>
            <div class="py-4">
              <div class="flex items-center justify-between gap-3">
                <h4 id="system-desktop" class="font-medium">Desktop</h4>
                <StateBadge :tone="desktopState.tone" :label="desktopState.label" />
              </div>
              <p class="mt-2 text-sm text-muted">
                {{ desktopState.detail }}
              </p>
              <details v-if="snapshot.desktop?.connected && !snapshot.desktop.current" class="mt-2 text-sm">
                <summary class="cursor-pointer entity-link">Update desktop</summary>
                <p class="mt-2 text-muted">
                  After active work finishes, run this command from the desktop control checkout. It updates both hosts.
                </p>
                <code class="mt-2 block break-all">pnpm service:hogwild:update</code>
                <p class="mt-2 font-mono text-xs text-muted">
                  Desktop protocol {{ snapshot.desktop.report?.protocol }}. Service protocol
                  {{ snapshot.desktop.protocol }}.
                </p>
              </details>
              <template v-if="desktopReport">
                <dl class="mt-3 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt class="text-muted">Agents</dt>
                    <dd class="mt-1 font-mono">
                      {{
                        desktopSlots === undefined
                          ? `${desktopReport.agents} running`
                          : `${desktopReport.agents} / ${desktopSlots}`
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-muted">GitHub Actions</dt>
                    <dd class="mt-1 font-mono">{{ desktopReport.actions }} running</dd>
                  </div>
                </dl>
                <div class="mt-4 flex items-center justify-between gap-2 text-sm">
                  <span class="text-muted">Memory committed</span>
                  <span class="font-mono">{{ desktopReport.reservedGiB }} / {{ desktopReport.memoryGiB }} GiB</span>
                </div>
                <UProgress
                  class="mt-2"
                  :model-value="desktopReport.reservedGiB"
                  :max="desktopReport.memoryGiB"
                  aria-label="Desktop memory committed"
                />
                <HostWork
                  :tasks="desktopTasks"
                  :tasks-available="snapshot.hostTasks !== undefined"
                  :jobs="desktopReport.jobs ?? { _tag: 'Unavailable' }"
                />
              </template>
              <div v-if="slotLimits && desktopSlots !== undefined" class="mt-4">
                <span id="desktop-slots-label" class="field-label">Agent slots</span>
                <div
                  class="mt-2 flex flex-wrap items-center gap-1.5"
                  role="group"
                  aria-labelledby="desktop-slots-label"
                >
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
              <div class="mt-4">
                <span class="field-label">Desktop memory</span>
                <p class="mt-2 font-mono text-sm">
                  {{ desktopReport ? `${desktopReport.memoryGiB} GiB` : 'Unavailable' }}
                </p>
                <p class="mt-2 text-xs text-muted">Shared by Agents and GitHub Actions.</p>
              </div>
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
              <dt class="field-label">Deployed commit</dt>
              <dd class="break-all font-mono text-sm text-muted">
                {{ update.deployedCommit || 'Unknown' }}
              </dd>
            </div>
            <div v-if="update.latestCommit" class="flex items-center justify-between gap-4 py-2.5">
              <dt class="field-label">Latest commit</dt>
              <dd class="break-all font-mono text-sm text-muted">
                {{ update.latestCommit }}
              </dd>
            </div>
            <div class="flex items-center justify-between gap-4 py-2.5">
              <dt class="field-label">Last checked</dt>
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
                <span class="font-mono text-sm" :class="row.tone === 'warning' ? 'status-warning' : undefined">{{
                  row.value
                }}</span>
              </div>
              <p class="mt-0.5 text-sm text-muted">
                {{ row.detail }}<template v-if="row.resetsAt"> · resets {{ relativeTime(row.resetsAt) }} </template>
              </p>
            </li>
          </ul>
          <p v-else class="mt-2 text-sm text-muted">No Agent provider limit reported.</p>
          <p v-for="notice in circuits" :key="notice.text" class="mt-2 text-sm status-warning">
            {{ notice.text
            }}<template v-if="notice._tag === 'Open'">
              {{ retryDeadline(notice.retryAt, now) }}. The next Agent request checks recovery.
            </template>
          </p>
        </section>

        <section aria-labelledby="system-classification">
          <h3 id="system-classification" class="field-label flex items-center gap-2">
            Classification
            <span class="h-px flex-1 bg-border" aria-hidden="true" />
          </h3>
          <div v-if="snapshot.classification !== undefined" class="mt-1 py-2.5">
            <div class="flex items-baseline justify-between gap-3">
              <span class="text-sm text-highlighted">Jev</span>
              <span class="font-mono text-sm text-muted">{{ snapshot.classification.model }}</span>
            </div>
            <p class="mt-0.5 text-sm text-muted">
              Pull request triage decisions via the {{ snapshot.classification.gatewayId }} gateway. Last 24 hours:
              {{ triageSummary }}.
            </p>
          </div>
          <p v-else class="mt-2 text-sm text-muted">
            Classification is not configured. Prose-only pull requests get a full Review.
          </p>
        </section>

        <section aria-labelledby="system-incidents">
          <h3 id="system-incidents" class="field-label flex items-center gap-2">
            Incidents <span class="font-mono">{{ incidents.length }}</span>
            <span class="h-px flex-1 bg-border" aria-hidden="true" />
          </h3>
          <ul v-if="incidents.length > 0" class="mt-1 divide-y divide-default">
            <li v-for="incident in visibleIncidents" :key="incident.id" class="space-y-1 py-3">
              <div class="flex flex-wrap items-center gap-2">
                <StateBadge :tone="incident.severity" :label="incidentKindLabel(incident)" />
                <a
                  v-if="incidentUrl(incident)"
                  :href="incidentUrl(incident)"
                  target="_blank"
                  rel="noreferrer"
                  class="entity-link text-sm"
                  >{{ incidentScopeLabel(incident) }}</a
                >
                <span v-else class="text-sm">{{ incidentScopeLabel(incident) }}</span>
              </div>
              <p class="text-sm">
                {{ incident.message }}
              </p>
              <p class="text-sm text-muted">
                {{ incidentRecoveryLabel(incident, now) }} · <span class="font-mono">{{ incident.occurrences }}×</span>
              </p>
              <p class="text-xs text-muted">
                First seen {{ relativeTime(incident.firstSeenAt) }}. Last seen {{ relativeTime(incident.lastSeenAt) }}.
              </p>
              <p v-if="incident.recovery._tag === 'Retrying'" class="text-xs text-muted">
                A due retry starts when the Controller has capacity. Check again after the next update.
              </p>
              <p v-else-if="incident.recovery._tag !== 'OnNextOperation'" class="text-xs text-muted">
                Open the linked repository or pull request to inspect the Incident.
              </p>
            </li>
          </ul>
          <UButton
            v-if="visibleIncidents.length < incidents.length"
            class="mt-3"
            color="neutral"
            variant="outline"
            @click="incidentLimit += 50"
          >
            Show more Incidents ({{ incidents.length - visibleIncidents.length }} remaining)
          </UButton>
          <p v-if="incidents.length === 0" class="mt-2 text-sm text-muted">No Incidents.</p>
        </section>

        <section v-if="snapshot.repairRecoveryCandidates.length > 0" aria-labelledby="system-repair-recovery">
          <h3 id="system-repair-recovery" class="field-label flex items-center gap-2">
            Repair recovery
            <span class="h-px flex-1 bg-border" aria-hidden="true" />
          </h3>
          <ul class="mt-1 divide-y divide-default">
            <li v-for="candidate in snapshot.repairRecoveryCandidates" :key="candidate.taskId" class="space-y-2 py-3">
              <a
                :href="`https://github.com/${candidate.repository}/pull/${candidate.pullRequestNumber}`"
                target="_blank"
                rel="noreferrer"
                class="entity-link break-all text-sm"
              >
                {{ candidate.repository }}#{{ candidate.pullRequestNumber }}
              </a>
              <p class="break-all text-sm">
                {{ candidate.reason }}
              </p>
              <UButton
                class="min-h-11"
                color="neutral"
                variant="outline"
                :aria-label="`Inspect Repair recovery for ${candidate.repository} number ${candidate.pullRequestNumber}`"
                @click="inspectRecovery(candidate)"
              >
                Inspect Repair recovery
              </UButton>
            </li>
          </ul>
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
              <p class="text-sm text-muted">Opened {{ relativeTime(batch.createdAt) }}. One permit.</p>
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
                      >{{ unit.issues }}</a
                    >
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
                  ><RepositoryIdentity :repository="record.routine.repository">
                    #{{ record.routine.trackingIssueNumber }}</RepositoryIdentity
                  ></a
                >
                <RepositoryIdentity
                  v-else
                  :repository="record.routine.repository"
                  class="font-mono text-sm text-muted"
                />
                <StateBadge :tone="record.tone" :label="record.label" class="ms-auto" />
              </div>
              <p class="text-sm text-muted">
                <template v-if="!record.routine.enabled"> Disabled. </template>
                <template v-else>
                  <template v-if="record.routine.lastRunAt">
                    Last {{ relativeTime(record.routine.lastRunAt) }}.
                  </template>
                  <template v-if="record.next"> Next {{ relativeTime(record.next) }}. </template>
                </template>
              </p>
              <p v-if="record.detail" class="text-sm">
                {{ record.detail }}
              </p>
              <p v-if="record.reportPending" class="text-sm status-warning">
                Report pending. <NuxtLink to="/watching" class="entity-link"> Enable writes in Watching. </NuxtLink>
              </p>
              <details v-if="record.latestRun && record.latestRun.candidates.length > 0" class="text-sm">
                <summary class="cursor-pointer text-muted">
                  {{ record.latestRun.candidates.length }}
                  {{ record.latestRun.candidates.length === 1 ? 'candidate' : 'candidates' }}
                </summary>
                <ul class="mt-2 space-y-2">
                  <li
                    v-for="candidate in record.latestRun.candidates"
                    :key="candidate.id"
                    class="rounded-md border border-default p-3"
                  >
                    <p>{{ candidate.claim }}</p>
                    <p class="mt-1 break-all font-mono text-sm text-muted">
                      {{ candidate.target }}
                    </p>
                  </li>
                </ul>
              </details>
              <details v-if="record.latestRun && record.latestRun.activity.length > 0" class="text-sm">
                <summary class="cursor-pointer text-muted">Terminal</summary>
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
                <dt class="field-label w-24">Temperature</dt>
                <dd
                  v-if="hostStatus.temperatures._tag === 'Available'"
                  class="flex flex-wrap items-center gap-x-4 gap-y-2"
                >
                  <span
                    v-for="temperature in hostStatus.temperatures.values"
                    :key="temperature.name"
                    class="inline-flex items-center gap-2 font-mono text-sm text-muted"
                  >
                    {{ formatHogwildTemperature(temperature) }}
                    <Sparkline
                      :data="hostHistory.temperatures[temperature.name]"
                      :label="`${temperature.name} temperature in °C`"
                    />
                  </span>
                </dd>
                <dd v-else class="font-mono text-sm text-muted">Unavailable</dd>
              </div>
              <div class="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
                <dt class="field-label w-24">Load</dt>
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
                  <span
                    class="font-mono text-sm"
                    :class="service.state._tag === 'Active' ? 'status-success' : 'status-warning'"
                    >{{ service.state._tag }}</span
                  >
                </div>
                <div
                  v-if="service.state._tag === 'Active'"
                  class="mt-1 flex flex-wrap items-center justify-between gap-2"
                >
                  <span class="font-mono text-sm text-muted">{{
                    formatHogwildServiceMetrics(service.state.metrics)
                  }}</span>
                  <Sparkline
                    :data="hostHistory.serviceMemoryMb[service.name]"
                    :label="`${service.name} memory in MB`"
                  />
                </div>
              </li>
            </ul>
          </template>
          <p v-else class="mt-2 text-sm text-muted">
            {{
              host._tag === 'Connecting'
                ? 'Waiting for host status.'
                : host._tag === 'Unavailable'
                  ? host.reason
                  : host._tag === 'Stale'
                    ? `Last host update ${relativeTime(new Date(host.updatedAt).toISOString())}. Host data is unavailable.`
                    : ''
            }}
          </p>
        </section>
      </template>
    </template>
  </USlideover>
  <RepairRecoverySlideover v-model:open="recoveryOpen" :candidate="recoveryCandidate" />
</template>
