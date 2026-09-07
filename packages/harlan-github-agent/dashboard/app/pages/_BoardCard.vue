<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { BoardCard, CardAction } from '../utils/dashboard.ts'
import ConfirmModal from '../components/ConfirmModal.vue'
import {
  approvalActionLabel,
  avatarUrl,
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
const confirming = ref<'cancel' | 'dismiss' | 'eject' | undefined>()

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
const ejectError = computed(() => agent.value === undefined ? undefined : ejectErrors.value[agent.value.id])

/** Errors that belong under the face. Cancel and Dismiss errors show in their modal instead. */
const faceErrors = computed(() => [
  entry.value === undefined ? undefined : approvalErrorFor(entry.value),
  rerunErrors.value[rerunKey.value],
  confirming.value === 'eject' ? undefined : ejectError.value,
  confirming.value === 'cancel' ? undefined : cancelError.value,
  confirming.value === 'dismiss' ? undefined : dismissError.value,
].filter((error): error is string => error !== undefined))

const kindIcon = { issue: 'i-octicon-issue-opened-16', pull_request: 'i-octicon-git-pull-request-16' }

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
  /* Eject ends the automated turn, so it sits with the other consequential actions and confirms. */
  const eject: DropdownMenuItem[] = canEject.value
    ? [{ label: 'Eject to terminal', icon: 'i-octicon-terminal-16', disabled: busy.value, onSelect: () => { confirming.value = 'eject' } }]
    : []
  return [quiet.map(item), [...eject, ...destructive.map(item)]].filter(group => group.length > 0)
})

const canEject = computed(() => agent.value !== undefined && agent.value.session._tag === 'Connected')

const consequence = computed(() => {
  if (confirming.value === 'cancel')
    return cancelConsequence(work.value)
  if (confirming.value === 'eject')
    return 'The automated turn stops and the saved session opens in Ghostty.'
  return dismissConsequence(identity.value?.kind ?? 'pull_request')
})

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
  if (confirming.value === 'eject' && agent.value !== undefined) {
    const id = agent.value.id
    await ejectAgent(id)
    if (ejectErrors.value[id] === undefined)
      confirming.value = undefined
    return
  }
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
    case 'Done': return 'bg-elevated/60 border-default hover:border-accented'
    default: return 'bg-elevated border-default hover:border-accented'
  }
})

defineExpose({
  focus: () => face.value?.focus(),
  pressPrimary,
})
</script>

<template>
  <article class="group relative rounded-md border p-3 transition-colors" :class="surfaceClass">
    <!-- The face. Stretched under the content so links and buttons stay their own controls. -->
    <button
      ref="face"
      type="button"
      class="absolute inset-0 rounded-md"
      :tabindex="tabindex"
      :aria-label="identity ? `Details for ${identity.repository} number ${identity.number}` : 'Details'"
      @click="slideoverOpen = true"
    />

    <div class="pointer-events-none relative flex flex-col gap-1.5 [&_a]:pointer-events-auto [&_button]:pointer-events-auto">
      <!-- Where it lives, and the menu that appears when the pointer arrives. -->
      <div class="flex items-center justify-between gap-2">
        <p v-if="identity" class="flex min-w-0 items-center gap-1 text-sm text-muted">
          <UIcon :name="kindIcon[identity.kind]" class="size-3.5 shrink-0 text-dimmed" aria-hidden="true" />
          <span class="sr-only">{{ identity.kind === 'issue' ? 'Issue' : 'Pull request' }}</span>
          <a :href="identity.url" target="_blank" rel="noreferrer" class="entity-link truncate">{{ identity.repository }}<span class="text-dimmed"> #{{ identity.number }}</span></a>
        </p>
        <p v-else-if="card._tag === 'Done' && card.record._tag === 'Task'" class="min-w-0 truncate text-sm text-muted">
          <a :href="taskSubjectUrl(card.record.task)" target="_blank" rel="noreferrer" class="entity-link">{{ card.record.task.repository }}<span class="text-dimmed"> #{{ taskNumber(card.record.task) }}</span></a>
        </p>
        <UDropdownMenu :items="menuItems" :content="{ align: 'end' }">
          <UButton
            icon="i-octicon-kebab-horizontal-16"
            color="neutral"
            variant="ghost"
            size="xs"
            square
            class="-my-1.5 -me-1.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
            :aria-label="identity ? `More actions for ${identity.repository} number ${identity.number}` : 'More actions'"
          />
        </UDropdownMenu>
      </div>

      <p v-if="identity" class="line-clamp-2 text-sm font-medium text-highlighted">
        <a :href="identity.url" target="_blank" rel="noreferrer" class="entity-link">{{ identity.title }}<span class="sr-only"> on GitHub</span></a>
      </p>

      <!-- The one state line. Clamped and ink: the slideover holds the rest, the badge holds the colour. -->
      <template v-if="card._tag === 'Running' && agent">
        <p class="flex items-center gap-2 text-sm">
          <LiveDot tone="success" live label="Agent running" />
          <span class="min-w-0 flex-1 truncate text-muted">{{ phase ?? 'Working' }}</span>
          <span class="shrink-0 font-mono text-dimmed">{{ duration(agent.startedAt) }}</span>
        </p>
        <p v-if="stalled" class="status-warning flex items-center gap-1.5 text-sm">
          <UIcon name="i-octicon-alert-16" class="size-3.5" aria-hidden="true" />
          {{ stalledLabel(agent, now) }}
        </p>
      </template>
      <p v-else-if="entry && stateLine" class="line-clamp-3 text-sm" :class="stateLine.tone === 'muted' ? 'text-muted' : 'text-default'">
        {{ stateLine.text }}
      </p>

      <!-- Footer: what kind of work, then who. The avatar sits where GitHub puts the assignee. -->
      <div class="mt-0.5 flex items-center gap-1.5">
        <StateBadge v-if="card._tag === 'Done'" :tone="badge.tone" :label="badge.label" :confidence="badge.confidence" :uppercase="badge.uppercase" />
        <WorkChip v-else-if="work" :work="work" />
        <span v-if="card._tag === 'Queued'" class="font-mono text-sm text-dimmed">{{ String(entry?.position).padStart(2, '0') }}</span>
        <a
          v-if="identity"
          :href="`https://github.com/${identity.author}`"
          target="_blank"
          rel="noreferrer"
          class="ms-auto shrink-0"
          :title="`@${identity.author}`"
        >
          <UAvatar :src="avatarUrl(identity.author)" :alt="`@${identity.author}`" size="2xs" />
        </a>
      </div>

      <!-- One decision, inline. Everything else is in the menu. -->
      <div v-if="primaryLabel" class="mt-1 flex flex-wrap items-center gap-1">
        <UButton
          size="sm"
          :loading="primaryPending"
          :disabled="busy"
          @click="pressPrimary"
        >
          {{ primaryLabel }}
        </UButton>
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
      :title="confirming === 'cancel' ? 'Cancel this task?' : confirming === 'eject' ? 'Eject this agent?' : `Dismiss this ${identity?.kind === 'issue' ? 'issue' : 'pull request'}?`"
      :consequence="consequence"
      :confirm-label="confirming === 'cancel' ? 'Cancel task' : confirming === 'eject' ? 'Eject' : 'Dismiss'"
      :pending="confirming === 'cancel' ? cancelling : confirming === 'eject' ? ejecting : dismissing"
      :tone="confirming === 'eject' ? 'primary' : 'error'"
      :error="confirming === 'cancel' ? cancelError : confirming === 'eject' ? ejectError : dismissError"
      @confirm="confirm"
    />
  </article>
</template>
