<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { BoardCard, CardAction } from '../utils/dashboard.ts'
import ConfirmModal from '../components/ConfirmModal.vue'
import {
  avatarUrl,
  boardCardBadge,
  boardCardIdentity,
  boardCardWork,
  cancelConsequence,
  cardActions,
  cardStateLine,
  dismissConsequence,
  isProgressStalled,
  repositoryName,
  runningPhaseLine,
  stalledLabel,
  taskNumber,
  taskSubjectUrl,
} from '../utils/dashboard.ts'
import { queueRecommendation } from '../utils/recommendation.ts'
import BoardCardSlideover from './_BoardCardSlideover.vue'

/**
 * One card, any column. The variant is the card's `_tag`, so the face shows
 * identity and one decision and nothing else. Every write goes through the
 * composable; this component only decides which controls exist.
 */
const { card, tabindex = 0 } = defineProps<{
  card: BoardCard
  /** Roving tabindex for the Needs you list. */
  tabindex?: 0 | -1
}>()

const {
  snapshot,
  now,
  duration,
  relativeTime,
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
const primaryControl = ref<{ $el: HTMLElement } | null>(null)
const slideoverOpen = ref(false)
const confirming = ref<'cancel' | 'dismiss' | 'eject' | undefined>()

const entry = computed(() => card._tag === 'Running' || card._tag === 'Done' ? undefined : card.entry)
const agent = computed(() => card._tag === 'Running' ? card.agent : undefined)
const work = computed(() => boardCardWork(card))
const identity = computed(() => boardCardIdentity(card, snapshot.value))
const badge = computed(() => boardCardBadge(card))
const stateLine = computed(() => entry.value === undefined ? undefined : cardStateLine(entry.value, snapshot.value, now.value))
const recommendation = computed(() => entry.value === undefined ? undefined : queueRecommendation(entry.value, snapshot.value))
const primaryLabel = computed(() => recommendation.value?.label)
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
  if (recommendation.value?._tag === 'OpenGitHub') {
    primaryControl.value?.$el.click()
    return
  }
  runPrimary()
}

function runPrimary(): void {
  if (entry.value === undefined || recommendation.value === undefined)
    return
  switch (recommendation.value._tag) {
    case 'OpenGitHub': return // The button is a normal link, including keyboard activation.
    case 'Inspect':
      slideoverOpen.value = true
      return
    case 'Approve':
      if (!busy.value)
        void approveQueueEntry(entry.value)
      return
    case 'Dismiss':
      if (!busy.value)
        confirming.value = 'dismiss'
  }
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

/**
 * Three shapes for three questions. Needs you is a one-line priority row, so
 * twenty decisions fit half a screen. Queued and Running are three-line cards.
 * Done is a one-line row, because an outcome is read, not decided.
 */
const shape = computed<'row' | 'card' | 'done'>(() => {
  if (card._tag === 'NeedsYou')
    return 'row'
  return card._tag === 'Done' ? 'done' : 'card'
})

/** The dot on a card's state line. Colour means state; grey means waiting its turn. */
const stateDot = computed<{ tone: 'success' | 'warning' | 'error' | 'neutral', live: boolean }>(() => {
  if (card._tag === 'Running')
    return { tone: stalled.value ? 'warning' : 'success', live: !stalled.value }
  if (stateLine.value?.tone === 'warning')
    return { tone: 'warning', live: false }
  if (stateLine.value?.tone === 'error')
    return { tone: 'error', live: false }
  return { tone: 'neutral', live: false }
})

/** The one truncated line under a card title, or beside a row title. */
const meta = computed(() => {
  if (card._tag === 'Running' && agent.value !== undefined)
    return stalled.value ? stalledLabel(agent.value, now.value) : (phase.value ?? 'Working')
  return stateLine.value?.text ?? ''
})

const doneAge = computed(() => card._tag === 'Done' ? shortAge(card.record.at, now.value) : '')

const menuButtonClass = 'shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100'

defineExpose({
  focus: () => face.value?.focus(),
  pressPrimary,
})
</script>

<template>
  <article
    class="group relative"
    :class="shape === 'card' ? 'rounded-md border border-default bg-elevated transition-colors hover:border-accented' : 'transition-colors hover:bg-muted'"
  >
    <!-- The face. Stretched under the content so links and buttons stay their own controls. -->
    <button
      ref="face"
      type="button"
      class="absolute inset-0"
      :class="shape === 'card' ? 'rounded-md' : undefined"
      :tabindex="tabindex"
      :aria-label="identity ? `Details for ${identity.repository} number ${identity.number}` : 'Details'"
      @click="slideoverOpen = true"
    />

    <!--
      Needs you: one decision. One line from md up; below md the fixed minimums
      would force the page sideways, so the tracks stack into four short lines.
    -->
    <div
      v-if="shape === 'row' && identity"
      class="pointer-events-none relative grid items-center gap-x-3 gap-y-0.5 px-2 py-2 [grid-template-areas:'dot_avatar_title'_'dot_avatar_repository'_'dot_avatar_meta'_'dot_avatar_actions'] grid-cols-[8px_20px_minmax(0,1fr)] md:h-8 md:gap-y-0 md:py-0 md:[grid-template-areas:'dot_avatar_title_repository_meta_actions'] md:grid-cols-[8px_20px_minmax(12rem,5fr)_minmax(8rem,3fr)_minmax(0,7fr)_12rem] [&_a]:pointer-events-auto [&_button]:pointer-events-auto"
    >
      <LiveDot class="[grid-area:dot]" :tone="badge.tone" :label="badge.label" />
      <a :href="`https://github.com/${identity.author}`" target="_blank" rel="noreferrer" class="flex [grid-area:avatar]" :title="`@${identity.author}`">
        <UAvatar :src="avatarUrl(identity.author)" :alt="`@${identity.author}`" size="2xs" />
      </a>
      <p class="flex min-w-0 items-center gap-1.5 text-sm font-medium text-highlighted [grid-area:title]">
        <UIcon :name="kindIcon[identity.kind]" class="size-3.5 shrink-0 text-dimmed" aria-hidden="true" />
        <span class="sr-only">{{ identity.kind === 'issue' ? 'Issue' : 'Pull request' }}</span>
        <a :href="identity.url" target="_blank" rel="noreferrer" class="entity-link truncate">{{ identity.title }}<span class="sr-only"> on GitHub</span></a>
      </p>
      <p class="min-w-0 truncate text-sm text-muted [grid-area:repository]">
        <a :href="identity.url" target="_blank" rel="noreferrer" class="entity-link">{{ identity.repository }}<span class="text-dimmed"> #{{ identity.number }}</span></a>
      </p>
      <p class="min-w-0 truncate text-sm text-muted [grid-area:meta]" :title="meta">
        {{ meta }}
      </p>
      <div class="flex items-center justify-end gap-1 [grid-area:actions]">
        <UButton
          v-if="primaryLabel"
          ref="primaryControl"
          size="xs"
          class="min-h-11 md:min-h-0"
          :loading="primaryPending"
          :disabled="busy && (recommendation?._tag === 'Approve' || recommendation?._tag === 'Dismiss')"
          :to="recommendation?._tag === 'OpenGitHub' ? recommendation.url : undefined"
          :target="recommendation?._tag === 'OpenGitHub' ? '_blank' : undefined"
          :rel="recommendation?._tag === 'OpenGitHub' ? 'noreferrer' : undefined"
          :trailing-icon="recommendation?._tag === 'OpenGitHub' ? 'i-octicon-link-external-16' : undefined"
          :title="recommendation?.description"
          @click="runPrimary"
        >
          {{ primaryLabel }}
        </UButton>
        <UDropdownMenu :items="menuItems" :content="{ align: 'end' }">
          <UButton
            icon="i-octicon-kebab-horizontal-16"
            color="neutral"
            variant="ghost"
            size="xs"
            square
            :class="menuButtonClass"
            :aria-label="`More actions for ${identity.repository} number ${identity.number}`"
          />
        </UDropdownMenu>
      </div>
    </div>

    <!-- Done: an outcome, then what it was about. -->
    <div
      v-else-if="shape === 'done'"
      class="pointer-events-none relative grid h-8 items-center gap-2.5 px-2.5 [&_a]:pointer-events-auto [&_button]:pointer-events-auto"
      style="grid-template-columns: 7.5rem minmax(0, 1fr) auto auto"
    >
      <StateBadge :tone="badge.tone" :label="badge.label" :confidence="badge.confidence" :uppercase="badge.uppercase" />
      <p class="min-w-0 truncate text-sm text-toned">
        <template v-if="identity">
          <a :href="identity.url" target="_blank" rel="noreferrer" class="entity-link text-muted">{{ repositoryName(identity.repository) }}<span class="text-dimmed"> #{{ identity.number }}</span></a>
          <span class="ms-1">{{ identity.title }}</span>
        </template>
        <a v-else-if="card._tag === 'Done' && card.record._tag === 'Task'" :href="taskSubjectUrl(card.record.task)" target="_blank" rel="noreferrer" class="entity-link text-muted">{{ repositoryName(card.record.task.repository) }}<span class="text-dimmed"> #{{ taskNumber(card.record.task) }}</span></a>
      </p>
      <time class="font-mono text-sm text-dimmed" :datetime="card._tag === 'Done' ? card.record.at : undefined" :title="card._tag === 'Done' ? relativeTime(card.record.at) : undefined">{{ doneAge }}</time>
      <UDropdownMenu :items="menuItems" :content="{ align: 'end' }">
        <UButton
          icon="i-octicon-kebab-horizontal-16"
          color="neutral"
          variant="ghost"
          size="xs"
          square
          class="-me-1.5"
          :class="menuButtonClass"
          :aria-label="identity ? `More actions for ${identity.repository} number ${identity.number}` : 'More actions'"
        />
      </UDropdownMenu>
    </div>

    <!-- Queued, Waiting, Running: three lines and a fixed shape. -->
    <div v-else class="pointer-events-none relative flex flex-col gap-0.5 py-2 pe-2 ps-2.5 [&_a]:pointer-events-auto [&_button]:pointer-events-auto">
      <div class="flex h-5 items-center gap-2">
        <p v-if="identity" class="flex min-w-0 flex-1 items-center gap-1 text-sm text-muted">
          <UIcon :name="kindIcon[identity.kind]" class="size-3.5 shrink-0 text-dimmed" aria-hidden="true" />
          <span class="sr-only">{{ identity.kind === 'issue' ? 'Issue' : 'Pull request' }}</span>
          <a :href="identity.url" target="_blank" rel="noreferrer" class="entity-link truncate">{{ identity.repository }}<span class="text-dimmed"> #{{ identity.number }}</span></a>
        </p>
        <span v-if="card._tag === 'Queued'" class="shrink-0 font-mono text-sm text-dimmed">{{ String(entry?.position).padStart(2, '0') }}</span>
        <a
          v-if="identity"
          :href="`https://github.com/${identity.author}`"
          target="_blank"
          rel="noreferrer"
          class="flex shrink-0"
          :title="`@${identity.author}`"
        >
          <UAvatar :src="avatarUrl(identity.author)" :alt="`@${identity.author}`" size="3xs" class="size-[18px]" />
        </a>
        <UDropdownMenu :items="menuItems" :content="{ align: 'end' }">
          <UButton
            icon="i-octicon-kebab-horizontal-16"
            color="neutral"
            variant="ghost"
            size="xs"
            square
            class="-my-1 -me-1"
            :class="menuButtonClass"
            :aria-label="identity ? `More actions for ${identity.repository} number ${identity.number}` : 'More actions'"
          />
        </UDropdownMenu>
      </div>

      <p v-if="identity" class="line-clamp-2 text-sm font-medium text-highlighted">
        <a :href="identity.url" target="_blank" rel="noreferrer" class="entity-link">{{ identity.title }}<span class="sr-only"> on GitHub</span></a>
      </p>

      <p class="flex h-5 items-center gap-2 text-sm">
        <LiveDot :tone="stateDot.tone" :live="stateDot.live" :label="card._tag === 'Running' ? 'Agent running' : undefined" />
        <span class="min-w-0 flex-1 truncate" :class="stateDot.tone === 'neutral' || stateDot.tone === 'success' ? 'text-muted' : 'text-default'" :title="meta">{{ meta }}</span>
        <span v-if="agent" class="shrink-0 font-mono text-dimmed">{{ duration(agent.startedAt) }}</span>
      </p>
    </div>

    <p v-for="error in faceErrors" :key="error" role="alert" class="status-error relative px-2.5 pb-2 text-sm">
      {{ error }}
    </p>

    <BoardCardSlideover
      v-model:open="slideoverOpen"

      :card="card"
      :identity="identity"
      :actions="actions"
      :recommendation="recommendation"
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
