<script setup lang="ts">
import type { AgentFeedbackInput } from '../../../src/types.ts'
import type { DetailItem } from '../components/DetailList.vue'
import type { FeedbackVerdict, HistoryRow } from '../utils/history.ts'
import { useClipboard } from '@vueuse/core'
import {
  gateTone,
  reviewOutcomeDetail,
  reviewUsageLabel,
  routineRunPresentation,
  taskKindLabel,
  taskNumber,
  taskProgressDetail,
  taskStateDetail,
  taskSubjectUrl,
} from '../utils/dashboard.ts'
import {
  canRerunReview,
  feedbackFormState,
  feedbackTone,
  gateRows,
  historyRowBadge,
  historyRowUrl,
  historyRowWork,
  reviewCommentUrl,
} from '../utils/history.ts'

/**
 * Everything a History row leaves out. For a Review run: the gates, the
 * findings, the Agent, its usage, the session, the commit, the canonical
 * comment, and the one place Agent feedback is recorded.
 *
 * The row stays a reference into the live snapshot, so a recorded verdict or
 * a queued rerun shows here as soon as the next snapshot lands.
 */
const { row } = defineProps<{ row: HistoryRow | undefined }>()
const open = defineModel<boolean>('open', { default: false })

const {
  snapshot,
  relativeTime,
  duration,
  feedbackPending,
  feedbackErrors,
  recordAgentFeedback,
  rerunPending,
  rerunErrors,
  rerunReview,
  itemKey,
} = useDashboard()
const { copy, copied, isSupported: clipboardSupported } = useClipboard()

const reason = ref('')
const chosen = ref<FeedbackVerdict>()

/* A new row means a new judgment. The draft never carries over. */
watch(() => row?.key, () => {
  reason.value = ''
  chosen.value = undefined
})

const review = computed(() => row?._tag === 'Review' ? row.agent : undefined)
const badge = computed(() => row === undefined ? undefined : historyRowBadge(row))
const work = computed(() => row === undefined ? undefined : historyRowWork(row))
const url = computed(() => row === undefined ? undefined : historyRowUrl(row, snapshot.value))

const title = computed(() => {
  if (row === undefined)
    return 'Evidence'
  if (row._tag === 'Review')
    return `${row.agent.repository}#${row.agent.pullRequestNumber}`
  if (row._tag === 'Task')
    return `${row.task.repository}#${taskNumber(row.task)}`
  return row.run.name
})

const description = computed(() => {
  if (row === undefined)
    return undefined
  if (row._tag === 'Review')
    return row.agent.title
  if (row._tag === 'Task')
    return taskKindLabel(row.task)
  return row.run.repository
})

/** The one sentence that explains the outcome. */
const outcome = computed(() => {
  if (row === undefined)
    return undefined
  if (row._tag === 'Review')
    return reviewOutcomeDetail(row.agent)
  if (row._tag === 'Task')
    return taskStateDetail(row.task)
  return routineRunPresentation(row.run).detail
})

const gates = computed(() => review.value === undefined ? [] : gateRows(review.value))
const findings = computed(() => review.value?.findings ?? [])
const candidates = computed(() => row?._tag === 'Routine' ? row.run.candidates : [])

const rerunKey = computed(() => review.value === undefined
  ? undefined
  : itemKey(review.value.repository, review.value.pullRequestNumber, review.value.revisionId))
const rerunAllowed = computed(() => review.value !== undefined && canRerunReview(review.value, snapshot.value))
const rerunning = computed(() => rerunKey.value !== undefined && rerunPending.value === rerunKey.value)
const rerunError = computed(() => rerunKey.value === undefined ? undefined : rerunErrors.value[rerunKey.value])

const feedback = computed(() => review.value === undefined
  ? undefined
  : feedbackFormState(review.value, reason.value, feedbackPending.value === review.value.id, feedbackErrors.value[review.value.id]))

const details = computed<DetailItem[]>(() => {
  if (row === undefined)
    return []
  if (row._tag === 'Review') {
    const { agent } = row
    const comment = reviewCommentUrl(agent)
    return [
      { term: 'Agent', value: `${agent.provider} · ${agent.model} · ${agent.agentVersion}` },
      { term: 'Review usage', value: agent.usage._tag === 'Unavailable' ? 'Unavailable' : reviewUsageLabel(agent.usage) },
      { term: 'Session', value: agent.sessionId, mono: true },
      { term: 'Head commit', value: agent.headSha.slice(0, 7), mono: true, href: agent.commitUrl },
      comment === undefined
        ? { term: 'Review comment', value: 'Not posted' }
        : { term: 'Review comment', value: 'Open the comment', href: comment },
      { term: 'Finished', value: relativeTime(agent.completedAt) },
      { term: 'Took', value: duration(agent.startedAt, agent.completedAt), mono: true },
    ]
  }
  if (row._tag === 'Task') {
    const { task } = row
    const items: DetailItem[] = [
      { term: 'Repository', value: `${task.repository}#${taskNumber(task)}`, mono: true, href: taskSubjectUrl(task) },
      { term: 'State', value: task.state._tag },
    ]
    if (taskProgressDetail(task) !== undefined)
      items.push({ term: 'Last phase', value: task.progress.label })
    items.push({ term: 'Finished', value: relativeTime(task.updatedAt) })
    items.push({ term: 'Task', value: task.id, mono: true })
    return items
  }
  const { run } = row
  return [
    { term: 'Repository', value: run.repository, href: `https://github.com/${run.repository}` },
    { term: 'Scheduled', value: relativeTime(run.scheduledFor) },
    { term: 'Mode', value: run.mode },
    { term: 'Report', value: run.reportState ?? 'None' },
    { term: 'Finished', value: relativeTime(run.updatedAt) },
    { term: 'Took', value: duration(run.createdAt, run.updatedAt), mono: true },
  ]
})

function save(verdict: FeedbackVerdict): void {
  if (review.value === undefined || feedback.value?._tag !== 'Open')
    return
  const text = feedback.value.reason
  const input: AgentFeedbackInput = verdict === 'Useful'
    ? { _tag: 'Useful', reason: text.length > 0 ? text : null }
    : { _tag: verdict, reason: text }
  chosen.value = verdict
  void recordAgentFeedback(review.value.id, input)
}

function rerun(): void {
  if (review.value !== undefined)
    void rerunReview(review.value.repository, review.value.pullRequestNumber, review.value.revisionId)
}

function candidateTone(result: { _tag: string }): 'success' | 'warning' | 'error' | 'neutral' {
  switch (result._tag) {
    case 'Merged': return 'success'
    case 'Proposed': return 'warning'
    case 'Rejected': return 'error'
    default: return 'neutral'
  }
}
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="title"
    :description="description"
    :ui="{ content: 'max-w-full lg:max-w-[30rem]' }"
  >
    <template #body>
      <div v-if="row && badge && work" class="flex flex-col gap-6">
        <div class="flex flex-wrap items-center gap-2">
          <StateBadge :tone="badge.tone" :label="badge.label" :confidence="badge.confidence" :uppercase="badge.uppercase" />
          <WorkChip :work="work" />
        </div>

        <p v-if="outcome" class="text-sm text-default">
          {{ outcome }}
        </p>

        <section v-if="review">
          <p class="field-label mb-2">
            Review gates
          </p>
          <ul class="divide-y divide-default border-y border-default" role="list">
            <li v-for="gate in gates" :key="gate.name" class="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span class="w-16 shrink-0 text-sm font-medium">{{ gate.name }}</span>
              <StateBadge :tone="gateTone(gate.state)" :label="gate.state._tag" />
              <span v-if="gate.state._tag !== 'Passed'" class="min-w-0 flex-1 basis-full text-sm text-muted sm:basis-auto">{{ gate.state.reason }}</span>
            </li>
          </ul>
        </section>

        <section v-if="review">
          <p class="field-label mb-2">
            Findings
          </p>
          <ul v-if="findings.length > 0" class="flex flex-col gap-3" role="list">
            <li v-for="(finding, index) in findings" :key="index" class="flex items-start gap-2">
              <StateBadge :tone="finding._tag === 'Fixed' ? 'success' : 'warning'" :label="finding._tag" class="mt-0.5" />
              <div class="min-w-0 text-sm">
                <p>{{ finding.summary }}</p>
                <p v-if="finding._tag === 'Open'" class="text-muted">
                  Next: {{ finding.nextAction }}
                </p>
              </div>
            </li>
          </ul>
          <p v-else class="text-sm text-muted">
            No findings.
          </p>
        </section>

        <section v-if="review && feedback">
          <p class="field-label mb-2">
            Agent feedback
          </p>
          <template v-if="feedback._tag === 'Recorded'">
            <div class="flex flex-wrap items-center gap-2">
              <StateBadge :tone="feedbackTone(feedback.feedback._tag)" :label="feedback.feedback._tag" />
              <time class="font-mono text-sm text-dimmed" :datetime="feedback.feedback.updatedAt">{{ relativeTime(feedback.feedback.updatedAt) }}</time>
            </div>
            <p v-if="feedback.feedback.reason" class="mt-2 text-sm text-muted">
              {{ feedback.feedback.reason }}
            </p>
          </template>
          <template v-else>
            <UTextarea
              v-model="reason"
              :rows="2"
              autoresize
              class="w-full"
              placeholder="Reason. Noisy and Wrong require one."
              aria-label="Agent feedback reason"
              :disabled="feedback.pending"
            />
            <div class="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="Agent feedback">
              <UButton
                size="xs"
                variant="outline"
                color="neutral"
                :loading="feedback.pending && chosen === 'Useful'"
                :disabled="!feedback.usefulEnabled"
                @click="save('Useful')"
              >
                Useful
              </UButton>
              <UButton
                size="xs"
                variant="outline"
                color="neutral"
                :loading="feedback.pending && chosen === 'Noisy'"
                :disabled="!feedback.reasonedEnabled"
                @click="save('Noisy')"
              >
                Noisy
              </UButton>
              <UButton
                size="xs"
                variant="outline"
                color="neutral"
                :loading="feedback.pending && chosen === 'Wrong'"
                :disabled="!feedback.reasonedEnabled"
                @click="save('Wrong')"
              >
                Wrong
              </UButton>
            </div>
            <p v-if="feedback.error" role="alert" class="status-error mt-2 text-sm">
              {{ feedback.error }}
            </p>
          </template>
        </section>

        <section v-if="row._tag === 'Routine'">
          <p class="field-label mb-2">
            Candidates · {{ candidates.length }}
          </p>
          <ul v-if="candidates.length > 0" class="divide-y divide-default border-y border-default" role="list">
            <li v-for="candidate in candidates" :key="candidate.id" class="flex flex-col gap-1 py-2">
              <div class="flex flex-wrap items-center gap-2">
                <StateBadge :tone="candidateTone(candidate.result)" :label="candidate.result._tag" />
                <span class="min-w-0 truncate font-mono text-sm text-dimmed">{{ candidate.target }}</span>
              </div>
              <p class="text-sm">
                {{ candidate.claim }}
              </p>
            </li>
          </ul>
          <p v-else class="text-sm text-muted">
            No candidates.
          </p>
        </section>

        <DetailList :items="details" />

        <div v-if="review && clipboardSupported">
          <UButton
            size="xs"
            variant="outline"
            color="neutral"
            :icon="copied ? 'i-octicon-check-16' : 'i-octicon-copy-16'"
            @click="copy(review.sessionId)"
          >
            {{ copied ? 'Copied' : 'Copy session id' }}
          </UButton>
        </div>

        <p v-if="rerunError" role="alert" class="status-error text-sm">
          {{ rerunError }}
        </p>
      </div>
    </template>

    <template #footer>
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          v-if="url"
          size="sm"
          variant="outline"
          color="neutral"
          icon="i-octicon-link-external-16"
          :to="url"
          target="_blank"
          rel="noreferrer"
        >
          Open on GitHub
        </UButton>
        <UButton
          v-if="rerunAllowed"
          size="sm"
          variant="outline"
          color="neutral"
          icon="i-octicon-sync-16"
          :loading="rerunning"
          :disabled="rerunPending !== undefined"
          @click="rerun"
        >
          Rerun review
        </UButton>
      </div>
    </template>
  </USlideover>
</template>
