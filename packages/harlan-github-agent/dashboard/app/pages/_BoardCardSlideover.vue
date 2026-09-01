<script setup lang="ts">
import type { DetailItem } from '../components/DetailList.vue'
import type { BoardCard, CardAction, CardIdentity } from '../utils/dashboard.ts'
import { useClipboard } from '@vueuse/core'
import {
  approvalConsequence,
  boardCardBadge,
  boardCardWork,
  cardStateLine,
  reviewOutcomeDetail,
  runningPhaseLine,
  taskProgressDetail,
  taskStateDetail,
} from '../utils/dashboard.ts'

/**
 * Everything a card face leaves out: the full reason, identifiers, the
 * terminal, and the same actions as the overflow menu. The owner of the card
 * performs the actions; this pane only asks for them.
 */
const {
  card,
  identity,
  actions,
  primaryLabel,
  primaryPending = false,
  taskId,
  busy = false,
} = defineProps<{
  card: BoardCard
  identity: CardIdentity | undefined
  actions: CardAction[]
  primaryLabel?: string
  primaryPending?: boolean
  /** The live Task behind the card, when one exists. */
  taskId?: string
  /** A write is in flight, so every other action waits. */
  busy?: boolean
}>()

const emit = defineEmits<{ act: [action: CardAction], primary: [], eject: [] }>()
const open = defineModel<boolean>('open', { default: false })
const { snapshot, now, relativeTime, duration } = useDashboard()
const { copy, copied } = useClipboard()

const badge = computed(() => boardCardBadge(card))
const work = computed(() => boardCardWork(card))

const title = computed(() => identity === undefined
  ? card._tag === 'Done' && card.record._tag === 'Task' ? card.record.task.repository : 'Details'
  : `${identity.repository}#${identity.number}`)

/** The full text the face only summarised. */
const text = computed(() => {
  if (card._tag === 'Running')
    return runningPhaseLine(card.agent) ?? ''
  if (card._tag === 'Done') {
    if (card.record._tag === 'Review')
      return reviewOutcomeDetail(card.record.agent)
    if (card.record._tag === 'Routine')
      return card.record.run.name
    return taskStateDetail(card.record.task) ?? taskProgressDetail(card.record.task) ?? ''
  }
  const line = cardStateLine(card.entry, snapshot.value, now.value).text
  return card.entry.state._tag === 'AwaitingApproval' ? `${line} ${approvalConsequence(card.entry)}` : line
})

const sessionId = computed(() => {
  if (card._tag === 'Running')
    return card.agent.session._tag === 'Connected' ? card.agent.session.id : undefined
  if (card._tag === 'Done' && card.record._tag === 'Review')
    return card.record.agent.sessionId
  return undefined
})

const details = computed<DetailItem[]>(() => {
  const items: DetailItem[] = []
  if (identity !== undefined)
    items.push({ term: 'Repository', value: identity.repository, href: `https://github.com/${identity.repository}` })
  if (card._tag === 'Running') {
    const { agent } = card
    if (agent.headSha !== undefined)
      items.push({ term: 'Head commit', value: agent.headSha.slice(0, 7), mono: true, href: agent.commitUrl })
    items.push({ term: 'Agent provider', value: agent.provider })
    items.push({ term: 'Elapsed', value: duration(agent.startedAt), mono: true })
    items.push({ term: 'Task', value: agent.id, mono: true })
  }
  else if (card._tag === 'Done') {
    if (card.record._tag === 'Review') {
      const { agent } = card.record
      items.push({ term: 'Head commit', value: agent.headSha.slice(0, 7), mono: true, href: agent.commitUrl })
      items.push({ term: 'Agent provider', value: `${agent.provider} · ${agent.model}` })
      items.push({ term: 'Finished', value: relativeTime(agent.completedAt) })
      items.push({ term: 'Took', value: duration(agent.startedAt, agent.completedAt), mono: true })
    }
    else if (card.record._tag === 'Task') {
      const { task } = card.record
      items.push({ term: 'Finished', value: relativeTime(task.updatedAt) })
      items.push({ term: 'Task', value: task.id, mono: true })
    }
  }
  else {
    const { entry } = card
    if (entry.kind === 'pull_request')
      items.push({ term: 'Head commit', value: entry.headSha.slice(0, 7), mono: true, href: entry.commitUrl })
    if (entry.state._tag === 'Queued')
      items.push({ term: 'Position', value: String(entry.position).padStart(2, '0'), mono: true })
    items.push({ term: 'Updated', value: relativeTime(entry.updatedAt) })
    if (taskId !== undefined)
      items.push({ term: 'Task', value: taskId, mono: true })
  }
  if (sessionId.value !== undefined)
    items.push({ term: 'Session', value: sessionId.value, mono: true })
  return items
})

const activity = computed(() => card._tag === 'Running' ? card.agent.activity : [])

const actionLabels: Record<CardAction, string> = {
  open: 'Open on GitHub',
  rerun: 'Rerun review',
  cancel: 'Cancel task',
  dismiss: 'Dismiss',
}

const canEject = computed(() => card._tag === 'Running' && card.agent.session._tag === 'Connected')
</script>

<template>
  <USlideover v-model:open="open" :title="title" :description="identity?.title">
    <template #body>
      <div class="flex flex-col gap-5">
        <div class="flex flex-wrap items-center gap-2">
          <StateBadge :tone="badge.tone" :label="badge.label" :confidence="badge.confidence" :uppercase="badge.uppercase" />
          <WorkChip v-if="work" :work="work" />
          <span v-if="card._tag === 'Running'" class="flex items-center gap-2 text-sm text-muted">
            <LiveDot tone="success" live label="Agent running" />
            <span class="font-mono text-sm">{{ duration(card.agent.startedAt) }}</span>
          </span>
        </div>

        <p v-if="text.length > 0" class="text-sm text-default">
          {{ text }}
        </p>

        <DetailList :items="details" />

        <div v-if="sessionId" class="flex items-center gap-2">
          <UButton
            size="xs"
            variant="outline"
            color="neutral"
            :icon="copied ? 'i-octicon-check-16' : 'i-octicon-copy-16'"
            @click="copy(sessionId)"
          >
            {{ copied ? 'Copied' : 'Copy session id' }}
          </UButton>
        </div>

        <div v-if="activity.length > 0">
          <p class="field-label mb-2">
            Terminal
          </p>
          <ol class="terminal" role="list">
            <li v-for="(item, index) in activity" :key="index">
              <template v-if="item._tag === 'Command'">
                <p>
                  <span class="mr-1.5 text-dimmed" aria-hidden="true">$</span>
                  <span>{{ item.command }}</span>
                  <span v-if="item.exitCode !== null && item.exitCode !== 0" class="status-error"> exit {{ item.exitCode }}</span>
                </p>
                <pre v-if="item.output.length > 0" class="whitespace-pre-wrap">{{ item.output }}</pre>
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
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex flex-wrap items-center gap-2">
        <UButton v-if="primaryLabel" size="sm" :loading="primaryPending" :disabled="busy" @click="emit('primary')">
          {{ primaryLabel }}
        </UButton>
        <ConfirmButton
          v-if="canEject"
          label="Eject"
          confirm-label="Confirm eject"
          aria-label="Eject this agent into your terminal"
          confirm-aria-label="Confirm ejecting this agent into your terminal"
          color="primary"
          icon="i-octicon-terminal-16"
          :disabled="busy"
          @confirm="emit('eject')"
        />
        <template v-for="action in actions" :key="action">
          <UButton
            v-if="action === 'open' && identity"
            size="sm"
            variant="outline"
            color="neutral"
            icon="i-octicon-link-external-16"
            :to="identity.url"
            target="_blank"
            rel="noreferrer"
          >
            {{ actionLabels.open }}
          </UButton>
          <UButton
            v-else-if="action !== 'open'"
            size="sm"
            variant="outline"
            :color="action === 'rerun' ? 'neutral' : 'error'"
            :icon="action === 'rerun' ? 'i-octicon-sync-16' : action === 'cancel' ? 'i-octicon-x-16' : 'i-octicon-circle-slash-16'"
            :disabled="busy"
            @click="emit('act', action)"
          >
            {{ actionLabels[action] }}
          </UButton>
        </template>
      </div>
    </template>
  </USlideover>
</template>
