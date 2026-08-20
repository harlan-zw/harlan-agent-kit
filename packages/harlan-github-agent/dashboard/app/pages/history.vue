<script setup lang="ts">
import type { ReviewAgent } from '../../../src/types.ts'
import { useClipboard } from '@vueuse/core'
import {
  buildHistory,
  gateTone,
  reviewOutcomeLabel,
  reviewOutcomeTone,
  statusClass,
  taskIsIssue,
  taskKindLabel,
  taskNumber,
  taskStateDetail,
  taskStateTone,
  taskSubjectUrl,
  taskWork,
} from '../utils/dashboard.ts'

const {
  snapshot,
  reviewAgents,
  relativeTime,
  duration,
  rerunPending,
  rerunErrors,
  rerunReview,
  isCurrentRevision,
  itemKey,
} = useDashboard()

const reviewGateNames = ['head', 'merge', 'metadata', 'review', 'verification', 'ci'] as const

const { copy, isSupported: clipboardSupported } = useClipboard()
const copiedSession = ref<string>()
const expanded = ref<Record<string, boolean>>({})
const outcomeFilter = ref<'all' | 'ready' | 'attention'>('all')

const records = computed(() => buildHistory(reviewAgents.value, snapshot.value.tasks))

const filtered = computed(() => records.value.filter((record) => {
  if (outcomeFilter.value === 'all')
    return true
  const good = record._tag === 'Review'
    ? record.agent.outcome._tag === 'Ready'
    : record.task.state._tag === 'Completed'
  return outcomeFilter.value === 'ready' ? good : !good
}))

function isExpanded(id: string): boolean {
  return expanded.value[id] === true
}

function toggle(id: string): void {
  expanded.value = { ...expanded.value, [id]: !isExpanded(id) }
}

function publishedReview(agent: ReviewAgent): string | undefined {
  const publication = agent.publications.find(candidate => candidate.result._tag === 'Published')
  return publication?.result._tag === 'Published' ? publication.result.url : undefined
}

function copySession(sessionId: string): void {
  void copy(sessionId).then(() => {
    copiedSession.value = sessionId
  })
}

useHead({
  meta: [{ name: 'description', content: 'Completed reviews and finished tasks, newest first.' }],
})
</script>

<template>
  <div>
    <div class="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <div class="zone-header mb-0 min-w-0 flex-1">
        <h1 class="field-label">
          History
        </h1>
        <span class="font-mono text-sm text-dimmed">{{ filtered.length }}</span>
        <hr class="zone-rule">
      </div>
      <div class="flex items-center gap-1" aria-label="Filter by outcome">
        <UButton
          v-for="filter in [
            { label: 'All', value: 'all' as const },
            { label: 'Succeeded', value: 'ready' as const },
            { label: 'Needs a look', value: 'attention' as const },
          ]"
          :key="filter.value"
          size="xs"
          :color="outcomeFilter === filter.value ? 'primary' : 'neutral'"
          :variant="outcomeFilter === filter.value ? 'soft' : 'ghost'"
          :aria-pressed="outcomeFilter === filter.value"
          @click="outcomeFilter = filter.value"
        >
          {{ filter.label }}
        </UButton>
      </div>
    </div>

    <ol v-if="filtered.length > 0" class="divide-y divide-default border-y border-default">
      <li v-for="record in filtered" :id="record._tag === 'Review' ? `agent-${record.agent.id}` : undefined" :key="record.key">
        <!-- Work that produces no review still gets a line, so nothing finishes invisibly. -->
        <div v-if="record._tag === 'Task'" class="grid gap-x-4 gap-y-1 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <UBadge
              :color="taskStateTone(record.task)"
              :class="taskStateTone(record.task) === 'neutral' ? undefined : statusClass(taskStateTone(record.task))"
              variant="subtle"
            >
              {{ record.task.state._tag }}
            </UBadge>
            <WorkChip :work="taskWork(record.task)" />
            <span class="text-sm">{{ taskKindLabel(record.task) }}</span>
            <a :href="taskSubjectUrl(record.task)" target="_blank" rel="noreferrer" class="entity-link font-mono text-xs text-dimmed">
              {{ record.task.repository }} · {{ taskIsIssue(record.task) ? 'Issue' : 'PR' }} #{{ taskNumber(record.task) }}
            </a>
          </div>
          <p class="font-mono text-xs text-dimmed md:text-right">
            {{ relativeTime(record.at) }}
          </p>
          <p v-if="taskStateDetail(record.task)" class="text-sm text-muted md:col-span-2">
            {{ taskStateDetail(record.task) }}
          </p>
        </div>

        <article v-else>
          <div class="grid gap-x-4 gap-y-2 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
            <div class="flex min-w-0 items-start gap-3">
              <UBadge
                class="mt-0.5 shrink-0"
                :color="reviewOutcomeTone(record.agent)"
                :class="statusClass(reviewOutcomeTone(record.agent))"
                variant="subtle"
              >
                {{ reviewOutcomeLabel(record.agent) }}
              </UBadge>
              <ItemIdentity
                :author="record.agent.author"
                :title="record.agent.title"
                :url="record.agent.subjectUrl"
                :repository="record.agent.repository"
                kind="pull_request"
                :number="record.agent.pullRequestNumber"
              />
            </div>
            <div class="flex flex-wrap items-center gap-1 md:justify-end">
              <span class="mr-2 font-mono text-xs text-dimmed">
                {{ relativeTime(record.agent.completedAt) }} · took {{ duration(record.agent.startedAt, record.agent.completedAt) }}
              </span>
              <UButton
                v-if="isCurrentRevision(record.agent)"
                size="sm"
                color="neutral"
                variant="ghost"
                icon="i-lucide-rotate-cw"
                :loading="rerunPending === itemKey(record.agent.repository, record.agent.pullRequestNumber, record.agent.revisionId)"
                :disabled="rerunPending !== undefined"
                :aria-label="`Rerun review for ${record.agent.repository} pull request ${record.agent.pullRequestNumber}`"
                @click="rerunReview(record.agent.repository, record.agent.pullRequestNumber, record.agent.revisionId)"
              >
                Rerun
              </UButton>
              <UButton
                size="sm"
                color="neutral"
                variant="ghost"
                :aria-expanded="isExpanded(record.agent.id)"
                :aria-controls="`agent-details-${record.agent.id}`"
                trailing-icon="i-lucide-chevron-down"
                :ui="{ trailingIcon: isExpanded(record.agent.id) ? 'rotate-180 transition-transform' : 'transition-transform' }"
                @click="toggle(record.agent.id)"
              >
                Evidence
              </UButton>
            </div>
          </div>

          <p v-if="rerunErrors[itemKey(record.agent.repository, record.agent.pullRequestNumber, record.agent.revisionId)]" role="alert" class="status-error pb-3 text-sm">
            {{ rerunErrors[itemKey(record.agent.repository, record.agent.pullRequestNumber, record.agent.revisionId)] }}
          </p>

          <div
            v-if="isExpanded(record.agent.id)"
            :id="`agent-details-${record.agent.id}`"
            class="mb-4 grid gap-8 rounded-md border border-default bg-muted/40 p-4 sm:p-5 xl:grid-cols-[minmax(0,1fr)_minmax(17rem,0.45fr)]"
          >
            <div>
              <p class="field-label mb-3">
                Review checks
              </p>
              <ul class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="list">
                <li v-for="gateName in reviewGateNames" :key="gateName" class="rounded-md border border-default bg-elevated p-3">
                  <div class="flex items-center justify-between gap-2">
                    <span class="font-mono text-sm">{{ gateName }}</span>
                    <UBadge
                      :color="gateTone(record.agent.gates[gateName])"
                      :class="statusClass(gateTone(record.agent.gates[gateName]))"
                      size="sm"
                      variant="subtle"
                    >
                      {{ record.agent.gates[gateName]._tag }}
                    </UBadge>
                  </div>
                  <p v-if="record.agent.gates[gateName]._tag !== 'Passed'" class="mt-2 text-sm text-muted">
                    {{ record.agent.gates[gateName].reason }}
                  </p>
                </li>
              </ul>

              <div class="mt-6">
                <p class="field-label mb-2">
                  Findings
                </p>
                <ul v-if="record.agent.findings.length > 0" class="grid gap-2" role="list">
                  <li v-for="(finding, findingIndex) in record.agent.findings" :key="findingIndex" class="text-sm">
                    <span class="font-medium">{{ finding._tag }}:</span> {{ finding.summary }}
                    <span v-if="finding._tag === 'Open'" class="block text-muted">Next: {{ finding.nextAction }}</span>
                  </li>
                </ul>
                <p v-else class="text-sm text-muted">
                  No material findings.
                </p>
              </div>
            </div>

            <dl class="grid content-start gap-4">
              <div>
                <dt class="field-label">
                  Agent
                </dt>
                <dd class="mt-1 font-mono text-sm">
                  {{ record.agent.provider }} · {{ record.agent.model }} · {{ record.agent.agentVersion }}
                </dd>
              </div>
              <div>
                <dt class="field-label">
                  Session
                </dt>
                <dd class="mt-1 flex items-center gap-1">
                  <code class="min-w-0 truncate font-mono text-sm">{{ record.agent.sessionId }}</code>
                  <UButton
                    v-if="clipboardSupported"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-copy"
                    :aria-label="`Copy session ${record.agent.sessionId}`"
                    @click="copySession(record.agent.sessionId)"
                  >
                    {{ copiedSession === record.agent.sessionId ? 'Copied' : 'Copy' }}
                  </UButton>
                </dd>
              </div>
              <div>
                <dt class="field-label">
                  Commit
                </dt>
                <dd class="mt-1 font-mono text-sm">
                  <a :href="record.agent.commitUrl" target="_blank" rel="noreferrer" class="entity-link break-all">{{ record.agent.headSha }}</a>
                </dd>
              </div>
              <div>
                <dt class="field-label">
                  Review comment
                </dt>
                <dd class="mt-1 text-sm">
                  <a v-if="publishedReview(record.agent)" :href="publishedReview(record.agent)" target="_blank" rel="noreferrer" class="entity-link">Open automated review</a>
                  <span v-else class="text-muted">No comment posted</span>
                </dd>
              </div>
            </dl>
          </div>
        </article>
      </li>
    </ol>
    <p v-else class="font-mono text-sm text-dimmed">
      Nothing has finished yet.
    </p>
  </div>
</template>
