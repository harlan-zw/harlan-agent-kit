<script setup lang="ts">
import type { ActiveAgent, AgentRole, QueueEntry } from '../../../src/types.ts'
import { useEventListener } from '@vueuse/core'
import {
  activeAgentProgress,
  activeAgentRole,
  activeEntries,
  approvalConsequence,
  buildHistory,
  incidentEntries,
  incidentKindLabel,
  incidentRecoveryLabel,
  incidentScopeLabel,
  incidentTone,
  incidentUrl,
  isIssueWorkThrottled,
  isProgressStalled,
  providerCapacityPresentation,
  queuedEntries,
  queueDetail,
  queueWork,
  recentlyFinished,
  reviewOutcomeLabel,
  reviewOutcomeTone,
  stalledLabel,
  statusClass,
  systemState,
  taskIsIssue,
  taskNumber,
  taskStateTone,
  taskSubjectUrl,
  taskWork,
  waitingEntries,
  workChipEntries,
} from '../utils/dashboard.ts'

const {
  snapshot,
  loading,
  activeAgents,
  reviewAgents,
  decisions,
  queueContext,
  now,
  relativeTime,
  duration,
  approvalPending,
  approvalKeyFor,
  approvalErrorFor,
  approveQueueEntry,
  cancelPending,
  cancelErrors,
  cancelAgentTask,
  ejectPending,
  ejectErrors,
  ejectAgent,
  taskFor,
  canRunReview,
  rerunPending,
  rerunErrors,
  rerunReview,
  itemKey,
  setAgentControl,
  controlPending,
  dismissItem,
  dismissPending,
  dismissErrors,
  dismissKey,
} = useDashboard()

const doneOnBoard = 8

const workFilter = ref<AgentRole | 'all'>('all')
const focusedDecision = ref(-1)
const decisionElements = ref<Array<HTMLElement | null>>([])

const incidents = computed(() => incidentEntries(snapshot.value.incidents))
const system = computed(() => systemState(snapshot.value))
const providerCapacities = computed(() => snapshot.value.providerCapacities.map(entry => ({
  ...entry,
  presentation: providerCapacityPresentation(entry),
})))
const recentlyFinishedRecords = computed(() => recentlyFinished(reviewAgents.value, snapshot.value.tasks))

/** Only offer a filter for work the board actually holds right now. */
const availableWork = computed(() => {
  const present = new Set<AgentRole>()
  snapshot.value.queue.forEach((entry) => {
    const work = queueWork(entry)
    if (work !== undefined)
      present.add(work)
  })
  activeAgents.value.forEach(agent => present.add(agent.role))
  return workChipEntries.filter(([role]) => present.has(role))
})

function matchesFilter(work: AgentRole | undefined): boolean {
  return workFilter.value === 'all' || work === workFilter.value
}

const needsYou = computed(() => decisions.value.filter(entry => matchesFilter(queueWork(entry))))
const running = computed(() => activeAgents.value.filter(agent => matchesFilter(agent.role)))
const runningWithoutAgent = computed(() => activeEntries(snapshot.value.queue, activeAgents.value).filter(entry => matchesFilter(queueWork(entry))))
const visibleQueued = computed(() => queuedEntries(snapshot.value.queue).filter(entry => matchesFilter(queueWork(entry))))

const queued = computed(() => visibleQueued.value.filter(entry => !isIssueWorkThrottled(entry, queueContext.value)))

/** Throttled issue work cannot start, so it belongs with the rest of the blocked work. */
const waiting = computed(() => [
  ...visibleQueued.value.filter(entry => isIssueWorkThrottled(entry, queueContext.value)),
  ...waitingEntries(snapshot.value.queue).filter(entry => matchesFilter(queueWork(entry))),
])

/**
 * Why the Up next column is empty, when it is.
 *
 * An empty forecast has three different causes and one of them is a control the
 * reader can act on, so the column has to name which it is.
 */
const nothingQueuedReason = computed(() => {
  if (queued.value.length > 0)
    return undefined
  if (queueContext.value.agentStart._tag === 'Paused')
    return { text: 'Agents are paused, so nothing will start.', resume: true }
  if (queueContext.value.agentStart._tag === 'WritesDisabled')
    return { text: 'GitHub writes are off, so no agent will start.', resume: false }
  if (queueContext.value.agentStart._tag === 'ReserveReached')
    return { text: 'Every automatic Agent provider reached its Reserve.', resume: false }
  if (queueContext.value.agentStart._tag === 'CapacityUnavailable')
    return { text: 'Agent provider limits could not load. The controller will retry.', resume: false }
  if (snapshot.value.selectionMode === 'manual' && needsYou.value.length > 0)
    return { text: 'Manual selection. Approve a pull request on the left to queue it.', resume: false }
  return { text: 'Nothing queued.', resume: false }
})
const done = computed(() => buildHistory(reviewAgents.value, snapshot.value.tasks)
  .filter(record => matchesFilter(record._tag === 'Review' ? 'adversarial_review' : taskWork(record.task)))
  .slice(0, doneOnBoard))

const doneTotal = computed(() => buildHistory(reviewAgents.value, snapshot.value.tasks).length)

function entryKey(entry: QueueEntry): string {
  return `${entry.repository}:${entry.kind}:${entry.number}`
}

function dismissLabels(subject: string) {
  return {
    ariaLabel: `Dismiss ${subject}, so no agent ever runs on it`,
    confirmAriaLabel: `Confirm dismissing ${subject}`,
  }
}

function cancelLabels(subject: string) {
  return {
    ariaLabel: `Cancel task for ${subject}`,
    confirmAriaLabel: `Confirm cancelling the task for ${subject}`,
  }
}

function agentSubject(agent: ActiveAgent): string {
  return `${agent.repository} ${agent.subjectKind === 'issue' ? 'issue' : 'pull request'} ${agent.itemNumber}`
}

function entrySubject(entry: QueueEntry): string {
  return `${entry.repository} ${entry.kind === 'issue' ? 'issue' : 'pull request'} ${entry.number}`
}

function focusDecision(index: number): void {
  if (needsYou.value.length === 0)
    return
  const next = Math.min(Math.max(index, 0), needsYou.value.length - 1)
  focusedDecision.value = next
  const element = decisionElements.value[next]
  element?.focus()
  element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement))
    return false
  return target.isContentEditable || /^(?:input|textarea|select)$/i.test(target.tagName)
}

useEventListener('keydown', (event: KeyboardEvent) => {
  if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target) || needsYou.value.length === 0)
    return
  if (event.key === 'j') {
    event.preventDefault()
    focusDecision(focusedDecision.value + 1)
    return
  }
  if (event.key === 'k') {
    event.preventDefault()
    focusDecision(focusedDecision.value <= 0 ? 0 : focusedDecision.value - 1)
    return
  }
  if (event.key === 'a') {
    event.preventDefault()
    const entry = needsYou.value[focusedDecision.value]
    if (entry !== undefined && entry.state._tag === 'AwaitingApproval' && approvalPending.value === undefined)
      void approveQueueEntry(entry)
  }
})

watch(needsYou, (entries) => {
  decisionElements.value.length = entries.length
  if (focusedDecision.value > entries.length - 1)
    focusedDecision.value = entries.length - 1
})

useHead({
  meta: [{ name: 'description', content: 'Live agents, Queue, and GitHub workflow state.' }],
})
</script>

<template>
  <div>
    <section id="system" aria-labelledby="system-heading" class="mb-6 scroll-mt-20">
      <div class="zone-header">
        <h2 id="system-heading" class="field-label" :class="statusClass(system.tone)">
          System
        </h2>
        <span class="font-mono text-xs" :class="statusClass(system.tone)">{{ system.label }}</span>
        <hr class="zone-rule">
      </div>

      <dl v-if="providerCapacities.length > 0" class="mb-2 grid gap-2 sm:grid-cols-2">
        <div
          v-for="entry in providerCapacities"
          :key="entry.provider"
          class="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border border-default bg-elevated px-3 py-2 text-sm"
        >
          <dt class="field-label">
            {{ entry.presentation.label }}
          </dt>
          <dd class="font-mono text-xs" :class="entry.presentation.tone === 'neutral' ? 'text-muted' : statusClass(entry.presentation.tone)">
            {{ entry.presentation.value }}
          </dd>
          <dd class="min-w-0 flex-1 text-right text-xs text-muted">
            {{ entry.presentation.detail }}<template v-if="entry.capacity._tag === 'Available'">
              · resets {{ relativeTime(entry.capacity.resetsAt) }}
            </template>
          </dd>
        </div>
      </dl>

      <ul v-if="incidents.length > 0" class="grid gap-2" role="list">
        <li
          v-for="incident in incidents"
          :key="incident.id"
          class="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm"
          :class="incident.severity === 'error' ? 'border-error/40 bg-error/5' : 'border-warning/40 bg-warning/5'"
        >
          <span class="font-mono text-xs" :class="statusClass(incidentTone(incident))">{{ incidentKindLabel(incident) }}</span>
          <a
            v-if="incidentUrl(incident)"
            :href="incidentUrl(incident)"
            target="_blank"
            rel="noreferrer"
            class="entity-link font-mono text-xs text-muted"
          >{{ incidentScopeLabel(incident) }}</a>
          <span v-else class="font-mono text-xs text-muted">{{ incidentScopeLabel(incident) }}</span>
          <span class="min-w-0 flex-1 break-words text-muted">{{ incident.message }}</span>
          <span class="font-mono text-xs" :class="statusClass(incident.recovery._tag === 'Retrying' ? 'primary' : 'error')">
            {{ incidentRecoveryLabel(incident) }}
          </span>
          <span class="font-mono text-xs text-dimmed">{{ incident.occurrences }}&times; · {{ relativeTime(incident.lastSeenAt) }}</span>
        </li>
      </ul>

      <section class="mt-3" aria-labelledby="recently-finished-heading">
        <div class="zone-header">
          <h3 id="recently-finished-heading" class="field-label">
            Recently finished
          </h3>
          <NuxtLink v-if="doneTotal > 0" to="/history" class="entity-link font-mono text-xs text-muted">
            All history
          </NuxtLink>
          <hr class="zone-rule">
        </div>

        <ol v-if="recentlyFinishedRecords.length > 0" class="divide-y divide-default border-y border-default">
          <li
            v-for="record in recentlyFinishedRecords"
            :key="record.key"
            class="grid gap-x-4 gap-y-1 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <UBadge
                v-if="record._tag === 'Review'"
                size="sm"
                :color="reviewOutcomeTone(record.agent)"
                :class="statusClass(reviewOutcomeTone(record.agent))"
                variant="subtle"
              >
                {{ reviewOutcomeLabel(record.agent) }}
              </UBadge>
              <UBadge
                v-else
                size="sm"
                :color="taskStateTone(record.task)"
                :class="taskStateTone(record.task) === 'neutral' ? undefined : statusClass(taskStateTone(record.task))"
                variant="subtle"
              >
                {{ record.task.state._tag }}
              </UBadge>
              <WorkChip :work="record._tag === 'Review' ? 'adversarial_review' : taskWork(record.task)" />
              <a
                v-if="record._tag === 'Review'"
                :href="record.agent.subjectUrl"
                target="_blank"
                rel="noreferrer"
                class="entity-link min-w-0 truncate text-sm"
              >
                {{ record.agent.title }}
              </a>
              <a
                v-else
                :href="taskSubjectUrl(record.task)"
                target="_blank"
                rel="noreferrer"
                class="entity-link min-w-0 truncate font-mono text-xs text-muted"
              >
                {{ record.task.repository }} · {{ taskIsIssue(record.task) ? 'Issue' : 'PR' }} #{{ taskNumber(record.task) }}
              </a>
            </div>
            <time :datetime="record.at" class="font-mono text-xs text-dimmed sm:text-right">
              {{ relativeTime(record.at) }}
            </time>
          </li>
        </ol>
        <p v-else class="font-mono text-sm text-dimmed">
          Nothing has finished yet.
        </p>
      </section>
    </section>

    <!-- Filter by what the work is for, which is the question a full board raises first. -->
    <div v-if="availableWork.length > 1" class="mb-4 flex flex-wrap items-center gap-1" aria-label="Filter by work">
      <UButton
        size="xs"
        :color="workFilter === 'all' ? 'primary' : 'neutral'"
        :variant="workFilter === 'all' ? 'soft' : 'ghost'"
        :aria-pressed="workFilter === 'all'"
        @click="workFilter = 'all'"
      >
        All
      </UButton>
      <UButton
        v-for="[role, chip] in availableWork"
        :key="role"
        size="xs"
        :icon="chip.icon"
        :color="workFilter === role ? 'primary' : 'neutral'"
        :variant="workFilter === role ? 'soft' : 'ghost'"
        :aria-pressed="workFilter === role"
        @click="workFilter = role"
      >
        {{ chip.label }}
      </UButton>
    </div>

    <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <!-- Column 1: the only work on the board that cannot resolve itself. -->
      <section aria-labelledby="needs-you-heading" class="flex min-w-0 flex-col">
        <div class="zone-header">
          <h2 id="needs-you-heading" class="field-label" :class="needsYou.length > 0 ? statusClass('warning') : undefined">
            Needs you
          </h2>
          <span class="font-mono text-sm" :class="needsYou.length > 0 ? statusClass('warning') : 'text-dimmed'">{{ needsYou.length }}</span>
          <hr class="zone-rule">
        </div>

        <ul v-if="needsYou.length > 0" class="grid content-start gap-2" role="list">
          <li
            v-for="(entry, index) in needsYou"
            :ref="element => { decisionElements[index] = element as HTMLElement | null }"
            :key="entryKey(entry)"
            class="rounded-md border border-warning/40 bg-warning/5 p-3"
            tabindex="-1"
          >
            <div class="mb-2 flex items-center justify-between gap-2">
              <WorkChip v-if="queueWork(entry)" :work="queueWork(entry)!" />
              <span v-else class="font-mono text-xs status-error">Action required</span>
            </div>
            <ItemIdentity
              :author="entry.author"
              :title="entry.title"
              :url="entry.subjectUrl"
              :repository="entry.repository"
              :kind="entry.kind"
              :number="entry.number"
            />
            <p v-if="entry.state._tag === 'ActionRequired'" class="status-error mt-2 text-sm">
              {{ entry.state.reason }}
            </p>
            <p v-else class="mt-2 text-sm text-muted">
              {{ approvalConsequence(entry) }}
            </p>
            <div class="mt-3 flex flex-wrap items-center gap-1">
              <UButton
                v-if="entry.state._tag === 'AwaitingApproval'"
                size="sm"
                :loading="approvalPending === approvalKeyFor(entry)"
                :disabled="approvalPending !== undefined"
                :aria-label="entry.state.kind === 'issue_work'
                  ? `Approve work for ${entrySubject(entry)}`
                  : `Review and repair ${entrySubject(entry)}`"
                @click="approveQueueEntry(entry)"
              >
                {{ entry.state.kind === 'issue_work' ? 'Approve' : 'Review and repair' }}
              </UButton>
              <UButton
                v-if="entry.state._tag === 'ActionRequired'"
                size="sm"
                color="neutral"
                variant="ghost"
                icon="i-lucide-external-link"
                :to="entry.subjectUrl"
                target="_blank"
                rel="noreferrer"
                :aria-label="`Open ${entrySubject(entry)} on GitHub`"
              >
                Open on GitHub
              </UButton>
              <ConfirmButton
                v-if="taskFor(entry)"
                label="Cancel"
                confirm-label="Confirm cancel"
                v-bind="cancelLabels(entrySubject(entry))"
                icon="i-lucide-circle-x"
                :loading="cancelPending === taskFor(entry)!.id"
                :disabled="cancelPending !== undefined"
                @confirm="cancelAgentTask(taskFor(entry)!.id)"
              />
              <ConfirmButton
                label="Dismiss"
                confirm-label="Never run this"
                v-bind="dismissLabels(entrySubject(entry))"
                color="neutral"
                icon="i-lucide-ban"
                :loading="dismissPending === dismissKey(entry.repository, entry.number)"
                :disabled="dismissPending !== undefined"
                @confirm="dismissItem(entry.repository, entry.number)"
              />
            </div>
            <p v-if="dismissErrors[dismissKey(entry.repository, entry.number)]" role="alert" class="status-error mt-2 text-sm">
              {{ dismissErrors[dismissKey(entry.repository, entry.number)] }}
            </p>
            <p v-if="approvalErrorFor(entry)" role="alert" class="status-error mt-2 text-sm">
              {{ approvalErrorFor(entry) }}
            </p>
            <p v-if="taskFor(entry) && cancelErrors[taskFor(entry)!.id]" role="alert" class="status-error mt-2 text-sm">
              {{ cancelErrors[taskFor(entry)!.id] }}
            </p>
          </li>
        </ul>
        <p v-else class="font-mono text-sm text-dimmed">
          Nothing waiting on you.
        </p>
      </section>

      <!-- Column 2: forecast, then what is blocked behind something else. -->
      <section aria-labelledby="up-next-heading" class="flex min-w-0 flex-col">
        <div class="zone-header">
          <h2 id="up-next-heading" class="field-label">
            Up next
          </h2>
          <span class="font-mono text-sm text-dimmed">{{ queued.length }}</span>
          <hr class="zone-rule">
        </div>

        <ol v-if="queued.length > 0" class="grid content-start gap-2">
          <li
            v-for="entry in queued"
            :key="entryKey(entry)"
            class="rounded-md border border-default bg-elevated p-3 transition-colors hover:border-accented"
          >
            <div class="mb-2 flex items-center justify-between gap-2">
              <WorkChip v-if="queueWork(entry)" :work="queueWork(entry)!" />
              <span class="font-mono text-xs tabular-nums text-dimmed">{{ String(entry.position).padStart(2, '0') }}</span>
            </div>
            <ItemIdentity
              :author="entry.author"
              :title="entry.title"
              :url="entry.subjectUrl"
              :repository="entry.repository"
              :kind="entry.kind"
              :number="entry.number"
            />
            <p class="mt-2 line-clamp-2 text-xs text-muted">
              {{ queueDetail(entry, queueContext) }}
            </p>
          </li>
        </ol>

        <div v-else-if="nothingQueuedReason" class="flex flex-wrap items-center gap-2">
          <p class="font-mono text-sm text-dimmed">
            {{ nothingQueuedReason.text }}
          </p>
          <UButton
            v-if="nothingQueuedReason.resume"
            size="xs"
            icon="i-lucide-play"
            :loading="controlPending"
            :disabled="controlPending"
            @click="setAgentControl('resume')"
          >
            Resume agents
          </UButton>
        </div>

        <!-- Blocked on something the engine does not control, so it never becomes a forecast. -->
        <template v-if="waiting.length > 0">
          <div class="zone-header mt-6">
            <h3 class="field-label">
              Waiting
            </h3>
            <span class="font-mono text-sm text-dimmed">{{ waiting.length }}</span>
            <hr class="zone-rule">
          </div>
          <ul class="grid content-start gap-2" role="list">
            <li
              v-for="entry in waiting"
              :key="entryKey(entry)"
              class="rounded-md border border-dashed border-default p-3"
            >
              <div class="mb-2 flex items-center justify-between gap-2">
                <WorkChip v-if="queueWork(entry)" :work="queueWork(entry)!" />
                <span class="font-mono text-xs text-dimmed">blocked</span>
              </div>
              <ItemIdentity
                :author="entry.author"
                :title="entry.title"
                :url="entry.subjectUrl"
                :repository="entry.repository"
                :kind="entry.kind"
                :number="entry.number"
              />
              <p class="mt-2 text-xs text-muted">
                {{ queueDetail(entry, queueContext) }}
              </p>
              <div class="mt-2 flex flex-wrap items-center gap-1">
                <UButton
                  v-if="canRunReview(entry)"
                  size="xs"
                  icon="i-lucide-play"
                  :loading="rerunPending === itemKey(entry.repository, entry.number, entry.revisionId)"
                  :disabled="rerunPending !== undefined"
                  :aria-label="`Run review for ${entrySubject(entry)}`"
                  @click="rerunReview(entry.repository, entry.number, entry.revisionId)"
                >
                  Run review
                </UButton>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-external-link"
                  :to="entry.subjectUrl"
                  target="_blank"
                  rel="noreferrer"
                  :aria-label="`Open ${entrySubject(entry)} on GitHub`"
                >
                  Open on GitHub
                </UButton>
                <ConfirmButton
                  label="Dismiss"
                  confirm-label="Never run this"
                  v-bind="dismissLabels(entrySubject(entry))"
                  color="neutral"
                  size="xs"
                  icon="i-lucide-ban"
                  :loading="dismissPending === dismissKey(entry.repository, entry.number)"
                  :disabled="dismissPending !== undefined"
                  @confirm="dismissItem(entry.repository, entry.number)"
                />
              </div>
              <p v-if="dismissErrors[dismissKey(entry.repository, entry.number)]" role="alert" class="status-error mt-2 text-sm">
                {{ dismissErrors[dismissKey(entry.repository, entry.number)] }}
              </p>
              <p v-if="rerunErrors[itemKey(entry.repository, entry.number, entry.revisionId)]" role="alert" class="status-error mt-2 text-sm">
                {{ rerunErrors[itemKey(entry.repository, entry.number, entry.revisionId)] }}
              </p>
            </li>
          </ul>
        </template>
      </section>

      <!-- Column 3: what is moving right now. -->
      <section aria-labelledby="running-heading" class="flex min-w-0 flex-col">
        <div class="zone-header">
          <h2 id="running-heading" class="field-label">
            Running
          </h2>
          <span class="font-mono text-sm text-dimmed">{{ running.length }}/{{ snapshot.agentProfile.maximumActiveAgents }}</span>
          <hr class="zone-rule">
        </div>

        <div v-if="loading" class="grid gap-2 rounded-md border border-default bg-elevated p-3" aria-label="Loading running agents">
          <div class="h-4 w-24 animate-pulse rounded bg-muted" aria-hidden="true" />
          <div class="h-12 animate-pulse rounded bg-muted" aria-hidden="true" />
        </div>

        <ul v-else-if="running.length > 0 || runningWithoutAgent.length > 0" class="grid content-start gap-2" role="list">
          <li
            v-for="agent in running"
            :id="`agent-${agent.id}`"
            :key="agent.id"
            class="rounded-md border border-default bg-elevated p-3"
          >
            <div class="mb-2 flex items-center justify-between gap-2">
              <WorkChip :work="agent.role" />
              <span class="flex items-center gap-1.5 font-mono text-xs text-muted">
                <span class="live-dot size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
                <span class="tabular-nums">{{ duration(agent.startedAt) }}</span>
              </span>
            </div>
            <ItemIdentity
              :author="agent.author"
              :title="agent.title"
              :url="agent.subjectUrl"
              :repository="agent.repository"
              :kind="agent.subjectKind === 'issue' ? 'issue' : 'pull_request'"
              :number="agent.itemNumber"
            />

            <p class="mt-2.5 line-clamp-2 text-xs text-muted">
              {{ activeAgentProgress(agent) }}
            </p>
            <div class="mt-1.5 flex items-center gap-2">
              <progress
                class="min-w-0 flex-1"
                :value="agent.progress.percent"
                max="100"
                :aria-label="`${activeAgentRole(agent)} progress`"
              />
              <span class="font-mono text-xs tabular-nums text-dimmed">{{ agent.progress.percent }}%</span>
            </div>
            <!-- Only appears once silence is long enough to mean something. -->
            <p v-if="isProgressStalled(agent, now)" class="status-warning mt-1.5 font-mono text-xs">
              {{ stalledLabel(agent, now) }}
            </p>

            <details v-if="agent.activity.length > 0" class="mt-2">
              <summary class="cursor-pointer font-mono text-xs text-dimmed">
                Terminal · {{ agent.activity.length }} step{{ agent.activity.length === 1 ? '' : 's' }}
              </summary>
              <ol class="agent-terminal mt-2" role="list">
                <li v-for="(item, itemIndex) in agent.activity" :key="itemIndex">
                  <template v-if="item._tag === 'Command'">
                    <p>
                      <span class="mr-1.5 text-dimmed" aria-hidden="true">$</span>
                      <span>{{ item.command }}</span>
                      <span v-if="item.exitCode !== null && item.exitCode !== 0" class="status-error"> exit {{ item.exitCode }}</span>
                    </p>
                    <pre v-if="item.output.length > 0">{{ item.output }}</pre>
                  </template>
                  <p v-else-if="item._tag === 'FileChange'">
                    <span class="text-dimmed">edited</span>
                    {{ item.changes.map(change => change.path).join(', ') }}
                  </p>
                  <p v-else class="text-dimmed">
                    {{ item.text }}
                  </p>
                </li>
              </ol>
            </details>

            <div class="mt-2 flex flex-wrap items-center gap-1">
              <ConfirmButton
                v-if="agent.session._tag === 'Connected'"
                label="Eject"
                confirm-label="Confirm eject"
                :aria-label="`Eject ${activeAgentRole(agent)} into an interactive terminal`"
                :confirm-aria-label="`Confirm ejecting ${activeAgentRole(agent)} into an interactive terminal`"
                color="primary"
                icon="i-lucide-square-terminal"
                :loading="ejectPending === agent.id"
                :disabled="ejectPending !== undefined || cancelPending !== undefined"
                @confirm="ejectAgent(agent.id)"
              />
              <ConfirmButton
                label="Cancel"
                confirm-label="Confirm cancel"
                v-bind="cancelLabels(agentSubject(agent))"
                icon="i-lucide-circle-x"
                :loading="cancelPending === agent.id"
                :disabled="cancelPending !== undefined || ejectPending !== undefined"
                @confirm="cancelAgentTask(agent.id)"
              />
            </div>
            <p v-if="cancelErrors[agent.id]" role="alert" class="status-error mt-2 text-sm">
              {{ cancelErrors[agent.id] }}
            </p>
            <p v-if="ejectErrors[agent.id]" role="alert" class="status-error mt-2 text-sm">
              {{ ejectErrors[agent.id] }}
            </p>
          </li>

          <!-- Started, but its agent session has not reported yet. -->
          <li
            v-for="entry in runningWithoutAgent"
            :key="entryKey(entry)"
            class="rounded-md border border-default bg-elevated p-3"
          >
            <div class="mb-2 flex items-center justify-between gap-2">
              <WorkChip v-if="queueWork(entry)" :work="queueWork(entry)!" />
              <span class="font-mono text-xs text-dimmed">starting</span>
            </div>
            <ItemIdentity
              :author="entry.author"
              :title="entry.title"
              :url="entry.subjectUrl"
              :repository="entry.repository"
              :kind="entry.kind"
              :number="entry.number"
            />
          </li>
        </ul>

        <p v-else class="font-mono text-sm text-dimmed">
          No agents running.
        </p>
      </section>

      <!-- Column 4: the terminus. Evidence lives on the History page. -->
      <section aria-labelledby="done-heading" class="flex min-w-0 flex-col">
        <div class="zone-header">
          <h2 id="done-heading" class="field-label">
            Done
          </h2>
          <span class="font-mono text-sm text-dimmed">{{ doneTotal }}</span>
          <hr class="zone-rule">
        </div>

        <ul v-if="done.length > 0" class="grid content-start gap-2" role="list">
          <li
            v-for="record in done"
            :key="record.key"
            class="rounded-md border border-default bg-elevated/60 p-3"
          >
            <div class="mb-2 flex items-center justify-between gap-2">
              <WorkChip :work="record._tag === 'Review' ? 'adversarial_review' : taskWork(record.task)" />
              <span class="font-mono text-xs text-dimmed">{{ relativeTime(record.at) }}</span>
            </div>
            <UBadge
              v-if="record._tag === 'Review'"
              class="mb-2"
              size="sm"
              :color="reviewOutcomeTone(record.agent)"
              :class="statusClass(reviewOutcomeTone(record.agent))"
              variant="subtle"
            >
              {{ reviewOutcomeLabel(record.agent) }}
            </UBadge>
            <UBadge
              v-else
              class="mb-2"
              size="sm"
              :color="taskStateTone(record.task)"
              :class="taskStateTone(record.task) === 'neutral' ? undefined : statusClass(taskStateTone(record.task))"
              variant="subtle"
            >
              {{ record.task.state._tag }}
            </UBadge>
            <ItemIdentity
              v-if="record._tag === 'Review'"
              :author="record.agent.author"
              :title="record.agent.title"
              :url="record.agent.subjectUrl"
              :repository="record.agent.repository"
              kind="pull_request"
              :number="record.agent.pullRequestNumber"
              size="sm"
            />
            <a
              v-else
              :href="taskSubjectUrl(record.task)"
              target="_blank"
              rel="noreferrer"
              class="entity-link block truncate font-mono text-xs text-muted"
            >
              {{ record.task.repository }} · {{ taskIsIssue(record.task) ? 'Issue' : 'PR' }} #{{ taskNumber(record.task) }}
            </a>
          </li>
        </ul>
        <p v-else class="font-mono text-sm text-dimmed">
          Nothing has finished yet.
        </p>

        <NuxtLink v-if="doneTotal > 0" to="/history" class="entity-link mt-3 font-mono text-sm text-muted">
          All history and evidence →
        </NuxtLink>
      </section>
    </div>

    <p class="mt-8 font-mono text-xs text-dimmed">
      <kbd>j</kbd> <kbd>k</kbd> move through Needs you · <kbd>a</kbd> approve
    </p>
  </div>
</template>
