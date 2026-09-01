<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { BoardCard, CardAction } from '../utils/dashboard.ts'
import ConfirmModal from '../components/ConfirmModal.vue'
import {
  activeAgentActivity,
  approvalActionLabel,
  boardCardBadge,
  boardCardIdentity,
  boardCardWork,
  cancelConsequence,
  cardActions,
  cardStateLine,
  dismissConsequence,
  isProgressStalled,
  runningPhaseLine,
  stalledLabel,
  taskNumber,
  taskSubjectUrl,
} from '../utils/dashboard.ts'
import BoardCardSlideover from './_BoardCardSlideover.vue'

/**
 * One card, any column. The variant is the card's `_tag`, so the face shows
 * identity and one decision and nothing else. Every write goes through the
 * composable; this component only decides which controls exist.
 */
const { card, tabindex = 0 } = defineProps<{
  card: BoardCard
  /** Roving tabindex for the Needs you column. */
  tabindex?: 0 | -1
}>()

const {
  snapshot,
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
  dismissItem,
  dismissPending,
  dismissErrors,
  dismissKey,
} = useDashboard()

const face = ref<HTMLButtonElement | null>(null)
const slideoverOpen = ref(false)
const confirming = ref<'cancel' | 'dismiss' | undefined>()

const entry = computed(() => card._tag === 'Running' || card._tag === 'Done' ? undefined : card.entry)
const agent = computed(() => card._tag === 'Running' ? card.agent : undefined)
const work = computed(() => boardCardWork(card))
const identity = computed(() => boardCardIdentity(card, snapshot.value))
const badge = computed(() => boardCardBadge(card))
const stateLine = computed(() => entry.value === undefined ? undefined : cardStateLine(entry.value, snapshot.value, now.value))
const primaryLabel = computed(() => entry.value === undefined ? undefined : approvalActionLabel(entry.value))
const task = computed(() => entry.value === undefined ? undefined : taskFor(entry.value))
const taskId = computed(() => agent.value?.id ?? task.value?.id)
const reviewAllowed = computed(() => entry.value !== undefined && canRunReview(entry.value))
const actions = computed(() => cardActions(card, { canRunReview: reviewAllowed.value, hasTask: taskId.value !== undefined }))
const activity = computed(() => agent.value === undefined ? undefined : activeAgentActivity(agent.value))
const phase = computed(() => agent.value === undefined ? undefined : runningPhaseLine(agent.value))
const stalled = computed(() => agent.value !== undefined && isProgressStalled(agent.value, now.value))

const approvalKey = computed(() => entry.value === undefined ? '' : approvalKeyFor(entry.value))
const rerunKey = computed(() => entry.value === undefined ? '' : itemKey(entry.value.repository, entry.value.number, entry.value.revisionId))
const itemDismissKey = computed(() => identity.value === undefined ? '' : dismissKey(identity.value.repository, identity.value.number))

const primaryPending = computed(() => approvalPending.value !== undefined && approvalPending.value === approvalKey.value)
const cancelling = computed(() => taskId.value !== undefined && cancelPending.value === taskId.value)
const dismissing = computed(() => itemDismissKey.value.length > 0 && dismissPending.value === itemDismissKey.value)
const ejecting = computed(() => agent.value !== undefined && ejectPending.value === agent.value.id)

/** Any write in flight on this board. One at a time keeps the result readable. */
const busy = computed(() => approvalPending.value !== undefined
  || cancelPending.value !== undefined
  || dismissPending.value !== undefined
  || ejectPending.value !== undefined
  || rerunPending.value !== undefined)

const cancelError = computed(() => taskId.value === undefined ? undefined : cancelErrors.value[taskId.value])
const dismissError = computed(() => dismissErrors.value[itemDismissKey.value])

/** Errors that belong under the face. Cancel and Dismiss errors show in their modal instead. */
const faceErrors = computed(() => [
  entry.value === undefined ? undefined : approvalErrorFor(entry.value),
  rerunErrors.value[rerunKey.value],
  agent.value === undefined ? undefined : ejectErrors.value[agent.value.id],
  confirming.value === 'cancel' ? undefined : cancelError.value,
  confirming.value === 'dismiss' ? undefined : dismissError.value,
].filter((error): error is string => error !== undefined))

const actionLabels: Record<CardAction, string> = {
  open: 'Open on GitHub',
  rerun: 'Rerun review',
  cancel: 'Cancel task',
  dismiss: 'Dismiss',
}

const actionIcons: Record<CardAction, string> = {
  open: 'i-octicon-link-external-16',
  rerun: 'i-octicon-sync-16',
  cancel: 'i-octicon-x-16',
  dismiss: 'i-octicon-circle-slash-16',
}

const menuItems = computed<DropdownMenuItem[][]>(() => {
  const quiet = actions.value.filter(action => action === 'open' || action === 'rerun')
  const destructive = actions.value.filter(action => action === 'cancel' || action === 'dismiss')
  const item = (action: CardAction): DropdownMenuItem => action === 'open'
    ? { label: actionLabels.open, icon: actionIcons.open, to: identity.value?.url, target: '_blank', rel: 'noreferrer' }
    : { label: actionLabels[action], icon: actionIcons[action], color: action === 'rerun' ? undefined : 'error', disabled: busy.value, onSelect: () => act(action) }
  return [quiet.map(item), destructive.map(item)].filter(group => group.length > 0)
})

const consequence = computed(() => confirming.value === 'cancel'
  ? cancelConsequence(work.value)
  : dismissConsequence(identity.value?.kind ?? 'pull_request'))

function pressPrimary(): void {
  if (entry.value === undefined || primaryLabel.value === undefined || busy.value)
    return
  void approveQueueEntry(entry.value)
}

function act(action: CardAction): void {
  if (action === 'open')
    return
  if (action === 'rerun') {
    if (entry.value !== undefined)
      void rerunReview(entry.value.repository, entry.value.number, entry.value.revisionId)
    return
  }
  confirming.value = action
}

async function confirm(): Promise<void> {
  if (confirming.value === 'cancel' && taskId.value !== undefined) {
    const id = taskId.value
    await cancelAgentTask(id)
    if (cancelErrors.value[id] === undefined)
      confirming.value = undefined
    return
  }
  if (confirming.value === 'dismiss' && identity.value !== undefined) {
    const key = itemDismissKey.value
    await dismissItem(identity.value.repository, identity.value.number)
    if (dismissErrors.value[key] === undefined)
      confirming.value = undefined
  }
}

function eject(): void {
  if (agent.value !== undefined)
    void ejectAgent(agent.value.id)
}

const confirmOpen = computed({
  get: () => confirming.value !== undefined,
  set: (value: boolean) => {
    if (!value)
      confirming.value = undefined
  },
})

const surfaceClass = computed(() => {
  switch (card._tag) {
    case 'NeedsYou': return 'bg-elevated border-warning'
    case 'Waiting': return 'bg-elevated border-dashed border-accented hover:border-inverted/40'
    case 'Done': return 'bg-elevated/60 border-default hover:border-accented text-muted'
    default: return 'bg-elevated border-default hover:border-accented'
  }
})

defineExpose({
  focus: () => face.value?.focus(),
  pressPrimary,
})
</script>

<template>
  <article class="relative rounded-md border p-3 transition-colors" :class="surfaceClass">
    <!-- The face. Stretched under the content so links and buttons stay their own controls. -->
    <button
      ref="face"
      type="button"
      class="absolute inset-0 rounded-md"
      :tabindex="tabindex"
      :aria-label="identity ? `Details for ${identity.repository} number ${identity.number}` : 'Details'"
      @click="slideoverOpen = true"
    />

    <div class="pointer-events-none relative flex flex-col gap-2 [&_a]:pointer-events-auto [&_button]:pointer-events-auto">
      <div class="flex items-start justify-between gap-2">
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <div v-if="card._tag === 'Done'" class="flex items-center gap-2">
            <StateBadge :tone="badge.tone" :label="badge.label" :confidence="badge.confidence" :uppercase="badge.uppercase" />
          </div>
          <EntityIdentity
            v-if="identity"
            :author="identity.author"
            :title="identity.title"
            :url="identity.url"
            :repository="identity.repository"
            :kind="identity.kind"
            :number="identity.number"
            :size="card._tag === 'Done' ? 'sm' : 'md'"
          />
          <p v-else-if="card._tag === 'Done' && card.record._tag === 'Task'" class="font-mono text-sm">
            <a :href="taskSubjectUrl(card.record.task)" target="_blank" rel="noreferrer" class="entity-link">{{ card.record.task.repository }}#{{ taskNumber(card.record.task) }}</a>
          </p>
        </div>
        <UDropdownMenu :items="menuItems" :content="{ align: 'end' }">
          <UButton
            icon="i-octicon-kebab-horizontal-16"
            color="neutral"
            variant="ghost"
            size="xs"
            square
            class="-mt-1 -mr-1 shrink-0"
            :aria-label="identity ? `More actions for ${identity.repository} number ${identity.number}` : 'More actions'"
          />
        </UDropdownMenu>
      </div>

      <!-- The one state line. -->
      <div v-if="card._tag === 'Running' && agent" class="flex flex-col gap-1.5">
        <div class="flex flex-wrap items-center gap-2">
          <WorkChip :work="agent.role" />
          <LiveDot tone="success" live label="Agent running" />
          <span v-if="phase" class="min-w-0 flex-1 truncate text-sm text-muted">{{ phase }}</span>
          <span class="ms-auto font-mono text-sm text-dimmed">{{ duration(agent.startedAt) }}</span>
        </div>
        <p v-if="activity" class="flex min-w-0 items-center justify-between gap-2 font-mono text-sm">
          <span class="min-w-0 truncate" :class="activity.tone === 'error' ? 'status-error' : 'text-dimmed'">{{ activity.text }}</span>
          <time class="shrink-0 text-dimmed" :datetime="activity.at">{{ relativeTime(activity.at) }}</time>
        </p>
        <p v-if="stalled" class="status-warning flex items-center gap-1.5 text-sm">
          <UIcon name="i-octicon-alert-16" class="size-3.5" aria-hidden="true" />
          {{ stalledLabel(agent, now) }}
        </p>
      </div>
      <div v-else-if="entry && stateLine" class="flex flex-col gap-1.5">
        <div class="flex flex-wrap items-center gap-2">
          <WorkChip v-if="work" :work="work" />
          <span v-if="card._tag === 'Queued'" class="font-mono text-sm text-dimmed">{{ String(entry.position).padStart(2, '0') }}</span>
        </div>
        <p
          class="text-sm"
          :class="stateLine.tone === 'muted' ? 'text-muted' : stateLine.tone === 'warning' ? 'status-warning' : 'status-error'"
        >
          {{ stateLine.text }}
        </p>
      </div>

      <!-- One decision, inline. Everything else is in the menu. -->
      <div v-if="primaryLabel || (agent && agent.session._tag === 'Connected')" class="flex flex-wrap items-center gap-1">
        <UButton
          v-if="primaryLabel"
          size="sm"
          :loading="primaryPending"
          :disabled="busy"
          @click="pressPrimary"
        >
          {{ primaryLabel }}
        </UButton>
        <ConfirmButton
          v-else-if="agent && agent.session._tag === 'Connected'"
          label="Eject"
          confirm-label="Confirm eject"
          aria-label="Eject this agent into your terminal"
          confirm-aria-label="Confirm ejecting this agent into your terminal"
          color="primary"
          size="xs"
          icon="i-octicon-terminal-16"
          :loading="ejecting"
          :disabled="busy"
          @confirm="eject"
        />
      </div>

      <p v-for="error in faceErrors" :key="error" role="alert" class="status-error text-sm">
        {{ error }}
      </p>
    </div>

    <BoardCardSlideover
      v-model:open="slideoverOpen"

      :card="card"
      :identity="identity"
      :actions="actions"
      :primary-label="primaryLabel"
      :primary-pending="primaryPending"
      :task-id="taskId"
      :busy="busy"
      @act="act"
      @primary="pressPrimary"
      @eject="eject"
    />

    <ConfirmModal
      v-model:open="confirmOpen"
      :title="confirming === 'cancel' ? 'Cancel this task?' : `Dismiss this ${identity?.kind === 'issue' ? 'issue' : 'pull request'}?`"
      :consequence="consequence"
      :confirm-label="confirming === 'cancel' ? 'Cancel task' : 'Dismiss'"
      :pending="confirming === 'cancel' ? cancelling : dismissing"
      :error="confirming === 'cancel' ? cancelError : dismissError"
      @confirm="confirm"
    />
  </article>
</template>
