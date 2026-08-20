<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { AgentProviderName } from '../../../src/agent-provider.ts'
import type {
  ActiveAgent,
  AgentModel,
  AgentSelection,
  AgentTask,
  CodexReasoningEffort,
  DashboardSnapshot,
  ItemSummary,
  PullRequestApprovalKind,
  QueueEntry,
  ReviewAgent,
  SelectionMode,
} from '../../../src/types.ts'
import { formatTimeAgo, useClipboard, useDocumentVisibility, useEventListener, useEventSource, useLocalStorage, useNow } from '@vueuse/core'
import { AGENT_MODELS, AGENT_PROVIDER_NAMES, CODEX_AGENT_PROFILE, REASONING_EFFORTS } from '../../../src/agent-profile.ts'
import {
  activeAgentProgress,
  activeAgentRole,
  agentRoleLabels,
  approvalConsequence,
  avatarUrl,
  buildHistory,
  decisionEntries,
  decisionKey,
  gateTone,
  incidentEntries,
  incidentKindLabel,
  incidentRecoveryLabel,
  incidentScopeLabel,
  incidentTone,
  incidentUrl,
  isProgressStalled,
  isSnapshotStale,
  queueDetail,
  queueStateLabel,
  queueStateTone,
  repositoryState,
  reviewOutcomeLabel,
  reviewOutcomeTone,
  stalledLabel,
  statusClass,
  taskIsIssue,
  taskKindLabel,
  taskNumber,
  taskStateDetail,
  taskStateTone,
  taskSubjectUrl,
  upNextEntries,
} from '../utils/dashboard.ts'

const reviewGateNames = ['head', 'merge', 'metadata', 'review', 'verification', 'ci'] as const
function emptySnapshot(): DashboardSnapshot {
  return {
    generatedAt: '',
    status: 'starting',
    mutationsEnabled: false,
    agentControl: { _tag: 'Running' },
    selectionMode: 'auto',
    agentProfile: CODEX_AGENT_PROFILE,
    agentSelection: { _tag: 'FollowsConfiguration' },
    agents: [],
    incidents: [],
    queue: [],
    repositories: [],
    items: [],
    tasks: [],
  }
}

const snapshot = shallowRef<DashboardSnapshot>(emptySnapshot())
const loading = ref(true)
const loadError = ref<string>()
const repositoryQuery = ref('')
const subjectFilter = ref<'all' | 'issue' | 'pull_request'>('all')
const approvalPending = ref<string>()
const approvalErrors = ref<Record<string, string>>({})
const cancelPending = ref<string>()
const cancelErrors = ref<Record<string, string>>({})
const ejectPending = ref<string>()
const ejectErrors = ref<Record<string, string>>({})
const rerunPending = ref<string>()
const rerunErrors = ref<Record<string, string>>({})
const controlPending = ref(false)
const controlError = ref<string>()
const copiedSession = ref<string>()
const reviewExpansion = ref<Record<string, boolean>>({})
const visibility = useDocumentVisibility()
const now = useNow({ interval: 1_000 })
const colorMode = useColorMode()
const { copy, isSupported: clipboardSupported } = useClipboard()

const cancelConfirmMilliseconds = 5_000

const notificationPreference = useLocalStorage('harlan-agent-notifications', false)
const notificationsSupported = ref(false)
const notificationsOn = ref(false)
const notificationError = ref<string>()
const seenDecisions = ref(new Set<string>())
const decisionsSeeded = ref(false)
const seenFailures = ref(new Set<string>())
const failuresSeeded = ref(false)
const focusedDecision = ref(-1)
const decisionElements = ref<Array<HTMLElement | null>>([])
const confirmingCancel = ref<string>()
const confirmingEject = ref<string>()
const repositoryPending = ref<string>()
let cancelConfirmTimer: ReturnType<typeof setTimeout> | undefined
let ejectConfirmTimer: ReturnType<typeof setTimeout> | undefined

const {
  data: liveSnapshot,
  error: liveError,
  open: openLiveUpdates,
  close: closeLiveUpdates,
  status: liveStatus,
} = useEventSource<['state'], DashboardSnapshot>('/api/events', ['state'], {
  immediate: false,
  autoReconnect: { delay: 1_500 },
  serializer: { read: value => JSON.parse(value ?? '{}') as DashboardSnapshot },
})

const activeAgents = computed(() => snapshot.value.agents.filter((agent): agent is ActiveAgent => agent._tag === 'ActiveAgent'))
const reviewAgents = computed(() => snapshot.value.agents.filter((agent): agent is ReviewAgent => agent._tag === 'ReviewAgent'))
const agentsCanStart = computed(() => snapshot.value.mutationsEnabled && snapshot.value.agentControl._tag === 'Running')
const agentControlLabel = computed(() => {
  if (snapshot.value.agentControl._tag === 'Running')
    return 'agents running'
  return snapshot.value.agentControl.safeToRestart ? 'paused, safe to restart' : 'paused, finishing active work'
})

const selectionModeHint = computed(() => snapshot.value.selectionMode === 'auto'
  ? 'The service reviews every eligible pull request. Switch to Manual to select each one.'
  : 'The service waits for you. Select a pull request with Review and repair, or the harlan-agent-review label.')

const decisions = computed(() => decisionEntries(snapshot.value.queue))
const upNext = computed(() => upNextEntries(snapshot.value.queue, activeAgents.value))
const queueContext = computed(() => ({
  agentsCanStart: agentsCanStart.value,
  agentsPaused: snapshot.value.agentControl._tag === 'Paused',
}))

/** Provider marks, so the running agent runtime is readable at a glance. */
const providerIcons: Record<AgentProviderName, string> = {
  codex: 'i-simple-icons-openai',
  opencode: 'i-simple-icons-opencode',
}

const providerLabels: Record<AgentProviderName, string> = {
  codex: 'Codex',
  opencode: 'opencode',
}

const activeProvider = computed(() => snapshot.value.agentProfile.provider)
const agentSelection = computed(() => snapshot.value.agentSelection)

/**
 * One control for the Agent provider, its model, and its reasoning effort.
 *
 * Switching the provider clears the model and the reasoning effort, because a
 * model belongs to one provider and the service refuses the other provider's.
 * Follow configuration hands the whole choice back to the configuration file.
 */
const agentSelectionItems = computed<DropdownMenuItem[][]>(() => {
  const selection = agentSelection.value
  const pinned = selection._tag === 'Pinned' ? selection : null
  // While the selection follows the configuration, the configured provider
  // decides, so its own models and role defaults are what the menu offers.
  const provider = pinned?.provider ?? activeProvider.value
  const pin = (model: AgentModel | null, reasoningEffort: CodexReasoningEffort | null): AgentSelection =>
    ({ _tag: 'Pinned', provider, model, reasoningEffort })
  return [
    [
      { label: 'Agent provider', type: 'label' },
      {
        label: 'Follow configuration',
        icon: 'i-lucide-file-cog',
        type: 'checkbox',
        checked: pinned === null,
        onUpdateChecked: () => switchAgent({ _tag: 'FollowsConfiguration' }),
      },
      ...AGENT_PROVIDER_NAMES.map(candidate => ({
        label: providerLabels[candidate],
        icon: providerIcons[candidate],
        type: 'checkbox' as const,
        checked: pinned?.provider === candidate,
        onUpdateChecked: () => switchAgent({ _tag: 'Pinned', provider: candidate, model: null, reasoningEffort: null }),
      })),
    ],
    [
      { label: 'Model', type: 'label' },
      {
        label: 'Provider default',
        type: 'checkbox',
        checked: (pinned?.model ?? null) === null,
        onUpdateChecked: () => switchAgent(pin(null, pinned?.reasoningEffort ?? null)),
      },
      ...AGENT_MODELS[provider].map(model => ({
        label: model,
        type: 'checkbox' as const,
        checked: pinned?.model === model,
        onUpdateChecked: () => switchAgent(pin(model, pinned?.reasoningEffort ?? null)),
      })),
    ],
    [
      { label: 'Reasoning effort', type: 'label' },
      {
        label: 'Provider default',
        type: 'checkbox',
        checked: (pinned?.reasoningEffort ?? null) === null,
        onUpdateChecked: () => switchAgent(pin(pinned?.model ?? null, null)),
      },
      ...REASONING_EFFORTS.map(reasoningEffort => ({
        label: reasoningEffort,
        type: 'checkbox' as const,
        checked: pinned?.reasoningEffort === reasoningEffort,
        onUpdateChecked: () => switchAgent(pin(pinned?.model ?? null, reasoningEffort)),
      })),
    ],
  ]
})

const unhealthyRepositories = computed(() => snapshot.value.repositories.filter(repository => repository.lastError !== null).length)

const incidents = computed(() => incidentEntries(snapshot.value.incidents))
/** Incidents the controller will not clear on its own. */
const blockingIncidents = computed(() => incidents.value.filter(incident => incident.recovery._tag !== 'Retrying').length)

const filteredRepositories = computed(() => {
  const query = repositoryQuery.value.trim().toLowerCase()
  return query.length === 0
    ? snapshot.value.repositories
    : snapshot.value.repositories.filter(repository => repository.github.toLowerCase().includes(query))
})
const filteredSubjects = computed(() => subjectFilter.value === 'all'
  ? snapshot.value.items
  : snapshot.value.items.filter(subject => subject.kind === subjectFilter.value))

const connectionLabel = computed(() => {
  if (liveStatus.value === 'OPEN')
    return 'Live'
  if (liveError.value !== null)
    return 'Reconnecting'
  return 'Connecting'
})

/** Old data on a monitoring surface is worse than no data, because it still looks authoritative. */
const isStale = computed(() => !loading.value && isSnapshotStale(snapshot.value.generatedAt, now.value))

const history = computed(() => buildHistory(reviewAgents.value, snapshot.value.tasks))

/**
 * Work that ended badly. It lands in History rather than the decisions zone,
 * so without this an agent that dies overnight is completely silent.
 */
const failures = computed(() => history.value.filter(record => record._tag === 'Task'
  ? record.task.state._tag === 'Failed'
  : record.agent.outcome._tag === 'Blocked'))

const documentTitle = computed(() => decisions.value.length > 0
  ? `(${decisions.value.length}) Agent activity | Harlan GitHub Agent`
  : 'Agent activity | Harlan GitHub Agent')

/**
 * A tab icon has 16 pixels, so it carries one signal: colour. Amber means a decision
 * is waiting, red means a repository is failing, emerald means nothing needs you.
 * Literal hex is unavoidable inside a data URI; these track the design tokens by hand.
 */
const faviconHref = computed(() => {
  const fill = decisions.value.length > 0 ? '#d97706' : unhealthyRepositories.value > 0 ? '#dc2626' : '#059669'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#171717"/><circle cx="16" cy="16" r="7" fill="${fill}"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
})

function relativeTime(value: string | null): string {
  void now.value
  return value === null || value.length === 0 ? 'Never' : formatTimeAgo(new Date(value))
}

function duration(startedAt: string, completedAt?: string): string {
  const end = completedAt === undefined ? now.value.getTime() : new Date(completedAt).getTime()
  const seconds = Math.max(0, Math.floor((end - new Date(startedAt).getTime()) / 1_000))
  if (seconds < 60)
    return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return seconds < 3_600 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function publishedReview(agent: ReviewAgent): string | undefined {
  const publication = agent.publications.find(candidate => candidate.result._tag === 'Published')
  return publication?.result._tag === 'Published' ? publication.result.url : undefined
}

function isReviewExpanded(agent: ReviewAgent, index: number): boolean {
  return reviewExpansion.value[agent.id] ?? index < 1
}

function toggleReview(agent: ReviewAgent, index: number): void {
  reviewExpansion.value = {
    ...reviewExpansion.value,
    [agent.id]: !isReviewExpanded(agent, index),
  }
}

function subjectKind(subject: ItemSummary): string {
  return subject.kind === 'issue' ? 'Issue' : 'Pull request'
}

function approvalKey(subject: Extract<ItemSummary, { kind: 'pull_request' }>, kind: PullRequestApprovalKind): string {
  return `${subject.repository}:${subject.number}:${subject.revisionId}:${kind}`
}

function queueApprovalKey(entry: QueueEntry): string {
  if (entry.state._tag !== 'AwaitingApproval')
    return ''
  return `${entry.repository}:${entry.number}:${entry.revisionId}:${entry.state.kind}`
}

function queueApprovalError(entry: QueueEntry): string | undefined {
  return approvalErrors.value[`${entry.repository}:${entry.number}:${entry.revisionId}`]
}

function queuePullRequest(entry: QueueEntry): Extract<ItemSummary, { kind: 'pull_request' }> | undefined {
  if (entry.kind !== 'pull_request')
    return undefined
  return snapshot.value.items.find((subject): subject is Extract<ItemSummary, { kind: 'pull_request' }> =>
    subject.kind === 'pull_request'
    && subject.repository === entry.repository
    && subject.number === entry.number
    && subject.revisionId === entry.revisionId,
  )
}

function queueTask(entry: QueueEntry): AgentTask | undefined {
  return snapshot.value.tasks.find(task =>
    task.repository === entry.repository
    && taskNumber(task) === entry.number
    && task.revisionId === entry.revisionId
    && task.state._tag !== 'Completed'
    && task.state._tag !== 'Superseded',
  )
}

function rerunKey(repository: string, pullRequestNumber: number, revisionId: string): string {
  return `${repository}:${pullRequestNumber}:${revisionId}`
}

function currentReviewSubject(agent: ReviewAgent): Extract<ItemSummary, { kind: 'pull_request' }> | undefined {
  return snapshot.value.items.find((subject): subject is Extract<ItemSummary, { kind: 'pull_request' }> =>
    subject.kind === 'pull_request'
    && subject.repository === agent.repository
    && subject.number === agent.pullRequestNumber
    && subject.revisionId === agent.revisionId,
  )
}

async function rerunReview(repository: string, pullRequestNumber: number, revisionId: string): Promise<void> {
  const key = rerunKey(repository, pullRequestNumber, revisionId)
  rerunPending.value = key
  rerunErrors.value = Object.fromEntries(Object.entries(rerunErrors.value).filter(([candidate]) => candidate !== key))
  return $fetch('/api/reviews/rerun', {
    method: 'POST',
    body: { repository, pullRequestNumber, revisionId },
  })
    .then(() => loadState())
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : 'The request failed.'
      rerunErrors.value = { ...rerunErrors.value, [key]: `${reason} Refresh and retry.` }
    })
    .finally(() => {
      rerunPending.value = undefined
    })
}

async function cancelAgentTask(taskId: string): Promise<void> {
  cancelPending.value = taskId
  cancelErrors.value = Object.fromEntries(Object.entries(cancelErrors.value).filter(([key]) => key !== taskId))
  return $fetch('/api/tasks/cancel', {
    method: 'POST',
    body: { taskId },
  })
    .then(() => loadState())
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : 'The request failed.'
      cancelErrors.value = { ...cancelErrors.value, [taskId]: `${reason} Refresh and retry.` }
    })
    .finally(() => {
      cancelPending.value = undefined
    })
}

async function setRepositoryPaused(repository: string, paused: boolean): Promise<void> {
  repositoryPending.value = repository
  controlError.value = undefined
  return $fetch(`/api/repositories/${paused ? 'pause' : 'resume'}`, {
    method: 'POST',
    body: { repository },
  })
    .then(() => loadState())
    .catch((error: unknown) => {
      controlError.value = error instanceof Error ? error.message : 'The request failed.'
    })
    .finally(() => {
      repositoryPending.value = undefined
    })
}

async function setSelectionMode(mode: SelectionMode): Promise<void> {
  controlPending.value = true
  controlError.value = undefined
  return $fetch('/api/agents/selection-mode', { method: 'POST', body: { mode } })
    .then(() => loadState())
    .catch((error: unknown) => {
      controlError.value = error instanceof Error ? error.message : 'The request failed.'
    })
    .finally(() => {
      controlPending.value = false
    })
}

async function setAgentControl(action: 'pause' | 'resume'): Promise<void> {
  controlPending.value = true
  controlError.value = undefined
  return $fetch(`/api/agents/${action}`, { method: 'POST' })
    .then(() => loadState())
    .catch((error: unknown) => {
      controlError.value = error instanceof Error ? error.message : 'The request failed.'
    })
    .finally(() => {
      controlPending.value = false
    })
}

/** A switch starts the next agent turn. Work already running keeps its model. */
async function switchAgent(selection: AgentSelection): Promise<void> {
  controlPending.value = true
  controlError.value = undefined
  return $fetch('/api/agents/select', { method: 'POST', body: selection })
    .then(() => loadState())
    .catch((error: unknown) => {
      controlError.value = error instanceof Error ? error.message : 'The request failed.'
    })
    .finally(() => {
      controlPending.value = false
    })
}

async function approvePullRequest(subject: Extract<ItemSummary, { kind: 'pull_request' }>, kind: PullRequestApprovalKind): Promise<void> {
  const pendingKey = approvalKey(subject, kind)
  const subjectKey = `${subject.repository}:${subject.number}:${subject.revisionId}`
  approvalPending.value = pendingKey
  approvalErrors.value = Object.fromEntries(Object.entries(approvalErrors.value).filter(([key]) => key !== subjectKey))
  return $fetch('/api/approvals', {
    method: 'POST',
    body: {
      repository: subject.repository,
      pullRequestNumber: subject.number,
      revisionId: subject.revisionId,
      kind,
    },
  })
    .then(() => loadState())
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : 'The request failed.'
      approvalErrors.value = { ...approvalErrors.value, [subjectKey]: `${reason} Refresh and retry.` }
    })
    .finally(() => {
      approvalPending.value = undefined
    })
}

async function approveQueueEntry(entry: QueueEntry): Promise<void> {
  if (entry.state._tag !== 'AwaitingApproval')
    return
  if (entry.state.kind === 'issue_work') {
    const subjectKey = `${entry.repository}:${entry.number}:${entry.revisionId}`
    approvalPending.value = queueApprovalKey(entry)
    approvalErrors.value = Object.fromEntries(Object.entries(approvalErrors.value).filter(([key]) => key !== subjectKey))
    return $fetch('/api/issues/approve', {
      method: 'POST',
      body: {
        repository: entry.repository,
        issueNumber: entry.number,
        revisionId: entry.revisionId,
      },
    })
      .then(() => loadState())
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : 'The request failed.'
        approvalErrors.value = { ...approvalErrors.value, [subjectKey]: `${reason} Refresh and retry.` }
      })
      .finally(() => {
        approvalPending.value = undefined
      })
  }
  const subject = queuePullRequest(entry)
  if (subject === undefined)
    return
  return approvePullRequest(subject, entry.state.kind)
}

function copySession(sessionId: string): void {
  void copy(sessionId).then(() => {
    copiedSession.value = sessionId
  })
}

async function loadState(): Promise<void> {
  loadError.value = undefined
  return $fetch<DashboardSnapshot>('/api/state')
    .then((value) => {
      snapshot.value = value
    })
    .catch((error: unknown) => {
      loadError.value = error instanceof Error
        ? `State could not load: ${error.message}. Check the local service.`
        : 'State could not load. Check the local service.'
    })
    .finally(() => {
      loading.value = false
    })
}

function toggleColorMode(): void {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}

/** Cancel kills minutes of agent work, so the first press only arms it. */
function requestCancel(taskId: string): void {
  clearTimeout(cancelConfirmTimer)
  if (confirmingCancel.value === taskId) {
    confirmingCancel.value = undefined
    void cancelAgentTask(taskId)
    return
  }
  confirmingCancel.value = taskId
  cancelConfirmTimer = setTimeout(() => {
    confirmingCancel.value = undefined
  }, cancelConfirmMilliseconds)
}

async function ejectAgent(taskId: string): Promise<void> {
  ejectPending.value = taskId
  ejectErrors.value = Object.fromEntries(Object.entries(ejectErrors.value).filter(([key]) => key !== taskId))
  return $fetch('/api/agents/eject', { method: 'POST', body: { taskId } })
    .then(() => loadState())
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : 'The request failed.'
      ejectErrors.value = { ...ejectErrors.value, [taskId]: reason }
    })
    .finally(() => {
      ejectPending.value = undefined
    })
}

function requestEject(taskId: string): void {
  clearTimeout(ejectConfirmTimer)
  if (confirmingEject.value === taskId) {
    confirmingEject.value = undefined
    void ejectAgent(taskId)
    return
  }
  confirmingEject.value = taskId
  ejectConfirmTimer = setTimeout(() => {
    confirmingEject.value = undefined
  }, cancelConfirmMilliseconds)
}

async function toggleNotifications(): Promise<void> {
  notificationError.value = undefined
  if (notificationsOn.value) {
    notificationsOn.value = false
    notificationPreference.value = false
    return
  }
  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission()
  if (permission !== 'granted') {
    notificationError.value = 'The browser blocked notifications. Allow them for this site, then try again.'
    return
  }
  notificationsOn.value = true
  notificationPreference.value = true
}

function notify(title: string, body: string, tag: string): void {
  if (Notification.permission !== 'granted')
    return
  const notification = new Notification(title, { body, tag })
  notification.onclick = () => {
    window.focus()
    notification.close()
  }
}

function notifyDecisions(fresh: QueueEntry[]): void {
  const first = fresh[0]
  if (first === undefined)
    return
  const body = fresh.length === 1
    ? `${first.repository} #${first.number}: ${first.title}`
    : `${fresh.length} items need your decision.`
  notify('Harlan GitHub Agent', body, 'harlan-agent-decisions')
}

function focusDecision(index: number): void {
  if (decisions.value.length === 0)
    return
  const next = Math.min(Math.max(index, 0), decisions.value.length - 1)
  focusedDecision.value = next
  const element = decisionElements.value[next]
  element?.focus()
  element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function approveFocusedDecision(): void {
  const entry = decisions.value[focusedDecision.value]
  if (entry === undefined || entry.state._tag !== 'AwaitingApproval' || approvalPending.value !== undefined)
    return
  void approveQueueEntry(entry)
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement))
    return false
  return target.isContentEditable || /^(?:input|textarea|select)$/i.test(target.tagName)
}

useEventListener('keydown', (event: KeyboardEvent) => {
  if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target))
    return
  if (event.key === '/') {
    event.preventDefault()
    document.querySelector<HTMLInputElement>('input[aria-label="Filter repositories"]')?.focus()
    return
  }
  if (decisions.value.length === 0)
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
    approveFocusedDecision()
  }
})

watch(decisions, (entries) => {
  decisionElements.value.length = entries.length
  if (focusedDecision.value > entries.length - 1)
    focusedDecision.value = entries.length - 1
  const keys = entries.map(decisionKey)
  const fresh = entries.filter((_, index) => !seenDecisions.value.has(keys[index]!))
  seenDecisions.value = new Set(keys)
  // The first snapshot only seeds the baseline, so opening the page never fires a notification.
  if (!decisionsSeeded.value) {
    decisionsSeeded.value = true
    return
  }
  if (notificationsOn.value && fresh.length > 0)
    notifyDecisions(fresh)
})

watch(failures, (records) => {
  const keys = records.map(record => record.key)
  const fresh = records.filter(record => !seenFailures.value.has(record.key))
  seenFailures.value = new Set(keys)
  if (!failuresSeeded.value) {
    failuresSeeded.value = true
    return
  }
  const first = fresh[0]
  if (!notificationsOn.value || first === undefined)
    return
  const subject = first._tag === 'Task'
    ? `${first.task.repository} #${taskNumber(first.task)}`
    : `${first.agent.repository} #${first.agent.pullRequestNumber}`
  const body = fresh.length === 1
    ? `${subject} did not succeed.`
    : `${fresh.length} agents did not succeed.`
  notify('Harlan GitHub Agent', body, 'harlan-agent-failures')
})

watch(liveSnapshot, (value) => {
  if (value !== null)
    snapshot.value = value
})

watch(visibility, (value) => {
  if (value === 'visible') {
    void loadState()
    openLiveUpdates()
    return
  }
  closeLiveUpdates()
})

onMounted(() => {
  void loadState()
  if (visibility.value === 'visible')
    openLiveUpdates()
  notificationsSupported.value = 'Notification' in window
  if (notificationsSupported.value && notificationPreference.value && Notification.permission === 'granted')
    notificationsOn.value = true
})

onBeforeUnmount(() => {
  clearTimeout(cancelConfirmTimer)
  clearTimeout(ejectConfirmTimer)
})

useHead({
  htmlAttrs: { lang: 'en' },
  title: documentTitle,
  link: [{ rel: 'icon', type: 'image/svg+xml', href: faviconHref }],
  meta: [
    { name: 'description', content: 'Live agents, Queue, and GitHub workflow state.' },
  ],
})
</script>

<template>
  <div class="min-h-screen">
    <a href="#main-content" class="skip-link">
      Skip to dashboard
    </a>

    <header class="sticky top-0 z-50 border-b border-default bg-default/85 backdrop-blur">
      <div class="mx-auto flex max-w-[90rem] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3 sm:px-6 lg:px-8">
        <a href="#main-content" class="entity-link flex min-w-0 items-center gap-2.5 no-underline">
          <span class="grid size-8 shrink-0 place-items-center rounded-md bg-inverted text-inverted">
            <UIcon name="i-lucide-bot" class="size-4.5" aria-hidden="true" />
          </span>
          <span class="truncate text-base font-semibold tracking-tight">Harlan GitHub Agent</span>
        </a>

        <div class="flex flex-wrap items-center justify-end gap-x-5 gap-y-2">
          <p class="flex items-center gap-2 font-mono text-sm text-muted">
            <span
              class="size-2 shrink-0 rounded-full"
              :class="liveStatus === 'OPEN' ? 'live-dot bg-success' : 'bg-warning'"
              aria-hidden="true"
            />
            <span>{{ connectionLabel }}</span>
            <span aria-hidden="true" class="text-dimmed">·</span>
            <span>{{ activeAgents.length }}/{{ snapshot.agentProfile.maximumActiveAgents }} agents</span>
            <span aria-hidden="true" class="text-dimmed">·</span>
            <span :class="snapshot.mutationsEnabled ? statusClass('warning') : undefined">writes {{ snapshot.mutationsEnabled ? 'on' : 'off' }}</span>
            <template v-if="snapshot.mutationsEnabled">
              <span aria-hidden="true" class="text-dimmed">·</span>
              <span :class="snapshot.agentControl._tag === 'Paused' ? statusClass('warning') : undefined">{{ agentControlLabel }}</span>
              <span aria-hidden="true" class="text-dimmed">·</span>
              <span :class="snapshot.selectionMode === 'manual' ? statusClass('warning') : undefined">{{ snapshot.selectionMode }} selection</span>
            </template>
            <template v-if="incidents.length > 0">
              <span aria-hidden="true" class="text-dimmed">·</span>
              <a
                href="#system"
                class="entity-link"
                :class="statusClass(blockingIncidents > 0 ? 'error' : 'warning')"
              >{{ incidents.length }} incident{{ incidents.length === 1 ? '' : 's' }}</a>
            </template>
            <template v-if="unhealthyRepositories > 0">
              <span aria-hidden="true" class="text-dimmed">·</span>
              <a href="#watching" class="entity-link" :class="statusClass('error')">{{ unhealthyRepositories }} repository issue{{ unhealthyRepositories === 1 ? '' : 's' }}</a>
            </template>
          </p>

          <div class="flex items-center gap-1">
            <UDropdownMenu
              :items="agentSelectionItems"
              :content="{ align: 'end' }"
              :ui="{ content: 'w-60' }"
            >
              <UButton
                :icon="providerIcons[activeProvider]"
                trailing-icon="i-lucide-chevron-down"
                color="neutral"
                variant="ghost"
                :loading="controlPending"
                title="Switch the Agent provider, model, or reasoning effort. A switch starts the next agent turn."
              >
                {{ providerLabels[activeProvider] }}
              </UButton>
            </UDropdownMenu>
            <UButton
              v-if="snapshot.mutationsEnabled"
              :icon="snapshot.selectionMode === 'auto' ? 'i-lucide-zap' : 'i-lucide-hand'"
              :color="snapshot.selectionMode === 'auto' ? 'neutral' : 'warning'"
              :variant="snapshot.selectionMode === 'auto' ? 'ghost' : 'soft'"
              :loading="controlPending"
              :disabled="controlPending"
              :title="selectionModeHint"
              @click="setSelectionMode(snapshot.selectionMode === 'auto' ? 'manual' : 'auto')"
            >
              {{ snapshot.selectionMode === 'auto' ? 'Auto' : 'Manual' }}
            </UButton>
            <UButton
              v-if="snapshot.mutationsEnabled"
              :icon="snapshot.agentControl._tag === 'Running' ? 'i-lucide-pause' : 'i-lucide-play'"
              :color="snapshot.agentControl._tag === 'Running' ? 'neutral' : 'primary'"
              :variant="snapshot.agentControl._tag === 'Running' ? 'ghost' : 'soft'"
              :loading="controlPending"
              :disabled="controlPending"
              @click="setAgentControl(snapshot.agentControl._tag === 'Running' ? 'pause' : 'resume')"
            >
              {{ snapshot.agentControl._tag === 'Running' ? 'Pause' : 'Resume' }}
            </UButton>
            <UButton to="/flow" icon="i-lucide-git-branch" color="neutral" variant="ghost">
              Flow
            </UButton>
            <UButton
              v-if="notificationsSupported"
              :icon="notificationsOn ? 'i-lucide-bell' : 'i-lucide-bell-off'"
              color="neutral"
              variant="ghost"
              square
              :aria-pressed="notificationsOn"
              :aria-label="notificationsOn ? 'Disable decision notifications' : 'Enable decision notifications'"
              :title="notificationsOn ? 'Decision notifications on' : 'Decision notifications off'"
              @click="toggleNotifications"
            />
            <UButton
              :icon="colorMode.value === 'dark' ? 'i-lucide-moon' : 'i-lucide-sun'"
              color="neutral"
              variant="ghost"
              square
              aria-label="Toggle color mode"
              @click="toggleColorMode"
            />
          </div>
        </div>
      </div>
    </header>

    <main id="main-content" tabindex="-1" class="mx-auto max-w-[90rem] px-4 py-8 sm:px-6 lg:px-8">
      <div class="mb-8 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h1 class="text-2xl font-semibold tracking-tight">
          Agent activity
        </h1>
        <p class="font-mono text-sm text-dimmed">
          Updated {{ relativeTime(snapshot.generatedAt) }}
        </p>
      </div>

      <div v-if="loadError" role="alert" class="mb-8 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-error/40 bg-error/5 p-4 text-sm">
        <span class="status-error">{{ loadError }}</span>
        <UButton size="sm" color="error" variant="soft" @click="loadState">
          Retry
        </UButton>
      </div>

      <div v-if="controlError" role="alert" class="mb-8 rounded-md border border-error/40 bg-error/5 p-4 text-sm status-error">
        Agent control failed: {{ controlError }}
      </div>

      <div v-if="notificationError" role="alert" class="mb-8 rounded-md border border-warning/40 bg-warning/5 p-4 text-sm status-warning">
        {{ notificationError }}
      </div>

      <div v-if="isStale" role="status" class="mb-8 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-warning/40 bg-warning/5 p-4 text-sm">
        <span class="status-warning">This is {{ relativeTime(snapshot.generatedAt) }}. The live connection is {{ connectionLabel.toLowerCase() }}, so the state below may have moved on.</span>
        <UButton size="sm" color="warning" variant="soft" @click="loadState">
          Reload now
        </UButton>
      </div>

      <div :class="isStale ? 'stale-content' : undefined">
        <!-- Zone 0: what is currently wrong. Absent when nothing is. -->
        <section v-if="incidents.length > 0" id="system" aria-labelledby="system-heading" class="mb-12 scroll-mt-20">
          <div class="zone-header">
            <h2 id="system-heading" class="field-label" :class="statusClass(blockingIncidents > 0 ? 'error' : 'warning')">
              System
            </h2>
            <span class="font-mono text-sm" :class="statusClass(blockingIncidents > 0 ? 'error' : 'warning')">{{ incidents.length }}</span>
            <hr class="zone-rule">
          </div>

          <ul class="grid gap-3" role="list">
            <li
              v-for="incident in incidents"
              :key="incident.id"
              class="rounded-md border p-4"
              :class="incident.severity === 'error' ? 'border-error/40 bg-error/5' : 'border-warning/40 bg-warning/5'"
            >
              <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-sm">
                    <span :class="statusClass(incidentTone(incident))">{{ incidentKindLabel(incident) }}</span>
                    <span aria-hidden="true" class="text-dimmed">·</span>
                    <a
                      v-if="incidentUrl(incident)"
                      :href="incidentUrl(incident)"
                      target="_blank"
                      rel="noreferrer"
                      class="entity-link text-muted"
                    >{{ incidentScopeLabel(incident) }}</a>
                    <span v-else class="text-muted">{{ incidentScopeLabel(incident) }}</span>
                    <span aria-hidden="true" class="text-dimmed">·</span>
                    <span class="text-dimmed">{{ incident.operation }}</span>
                  </div>
                  <p class="mt-2 break-words text-sm text-muted">
                    {{ incident.message }}
                  </p>
                </div>
                <div class="flex flex-col gap-1 font-mono text-sm sm:items-end">
                  <span :class="statusClass(incident.recovery._tag === 'Retrying' ? 'primary' : 'error')">
                    {{ incidentRecoveryLabel(incident) }}
                  </span>
                  <span class="text-dimmed">
                    {{ incident.occurrences }}&times; · {{ relativeTime(incident.lastSeenAt) }}
                  </span>
                </div>
              </div>
            </li>
          </ul>
        </section>

        <!-- Zone 1: the only thing on the page that cannot resolve itself. Absent when empty. -->
        <section v-if="decisions.length > 0" id="decisions" aria-labelledby="decisions-heading" class="mb-12 scroll-mt-20">
          <div class="zone-header">
            <h2 id="decisions-heading" class="field-label status-warning">
              Needs you
            </h2>
            <span class="font-mono text-sm status-warning">{{ decisions.length }}</span>
            <hr class="zone-rule">
          </div>

          <ul class="grid gap-3" role="list">
            <li
              v-for="(entry, index) in decisions"
              :ref="element => { decisionElements[index] = element as HTMLElement | null }"
              :key="`${entry.repository}:${entry.kind}:${entry.number}`"
              class="rounded-md border border-warning/40 bg-warning/5 p-4"
              tabindex="-1"
            >
              <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div class="min-w-0">
                  <a :href="entry.subjectUrl" target="_blank" rel="noreferrer" class="entity-link text-base font-medium">
                    {{ entry.title }}
                    <span class="sr-only"> on GitHub</span>
                  </a>
                  <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-sm text-muted">
                    <UAvatar :src="avatarUrl(entry.author)" :alt="entry.author" size="2xs" />
                    <a :href="`https://github.com/${entry.author}`" target="_blank" rel="noreferrer" class="entity-link">@{{ entry.author }}</a>
                    <span aria-hidden="true">·</span>
                    <a :href="entry.repositoryUrl" target="_blank" rel="noreferrer" class="entity-link">{{ entry.repository }}</a>
                    <span aria-hidden="true">·</span>
                    <a :href="entry.subjectUrl" target="_blank" rel="noreferrer" class="entity-link">{{ entry.kind === 'issue' ? 'Issue' : 'PR' }} #{{ entry.number }}</a>
                  </div>
                  <p v-if="entry.state._tag === 'ActionRequired'" class="status-error mt-2 text-sm">
                    {{ entry.state.reason }}
                  </p>
                  <p v-else class="mt-2 text-sm text-muted">
                    {{ approvalConsequence(entry) }}
                  </p>
                </div>

                <div class="flex items-center gap-2 sm:justify-end">
                  <UButton
                    v-if="entry.state._tag === 'AwaitingApproval'"
                    :loading="approvalPending === queueApprovalKey(entry)"
                    :disabled="approvalPending !== undefined"
                    :aria-label="entry.state.kind === 'issue_work'
                      ? `Approve work for ${entry.repository} issue ${entry.number}`
                      : `Review and repair ${entry.repository} pull request ${entry.number}`"
                    @click="approveQueueEntry(entry)"
                  >
                    {{ entry.state.kind === 'issue_work' ? 'Approve' : 'Review and repair' }}
                  </UButton>
                  <UButton
                    v-if="queueTask(entry)"
                    color="error"
                    :variant="confirmingCancel === queueTask(entry)!.id ? 'solid' : 'ghost'"
                    icon="i-lucide-circle-x"
                    :loading="cancelPending === queueTask(entry)!.id"
                    :disabled="cancelPending !== undefined"
                    :aria-label="confirmingCancel === queueTask(entry)!.id
                      ? `Confirm cancelling the task for ${entry.repository} ${entry.kind === 'issue' ? 'issue' : 'pull request'} ${entry.number}`
                      : `Cancel task for ${entry.repository} ${entry.kind === 'issue' ? 'issue' : 'pull request'} ${entry.number}`"
                    @click="requestCancel(queueTask(entry)!.id)"
                  >
                    {{ confirmingCancel === queueTask(entry)!.id ? 'Confirm cancel' : 'Cancel' }}
                  </UButton>
                </div>
              </div>

              <p v-if="queueApprovalError(entry)" role="alert" class="status-error mt-3 text-sm">
                {{ queueApprovalError(entry) }}
              </p>
              <p v-if="queueTask(entry) && cancelErrors[queueTask(entry)!.id]" role="alert" class="status-error mt-3 text-sm">
                {{ cancelErrors[queueTask(entry)!.id] }}
              </p>
            </li>
          </ul>
        </section>

        <!-- Zone 2: what is moving right now. Largest surface on the page. -->
        <section id="running" aria-labelledby="running-heading" class="mb-12 scroll-mt-20">
          <div class="zone-header">
            <h2 id="running-heading" class="field-label">
              Running now
            </h2>
            <span class="font-mono text-sm text-dimmed">{{ activeAgents.length }}/{{ snapshot.agentProfile.maximumActiveAgents }}</span>
            <hr class="zone-rule">
          </div>

          <div v-if="loading" class="grid gap-4 rounded-md border border-default bg-elevated p-5" aria-label="Loading running agents">
            <div class="h-5 w-40 animate-pulse rounded bg-muted" aria-hidden="true" />
            <div class="h-20 animate-pulse rounded bg-muted" aria-hidden="true" />
          </div>

          <div v-else-if="activeAgents.length > 0" class="grid gap-4 xl:grid-cols-2">
            <article
              v-for="agent in activeAgents"
              :id="`agent-${agent.id}`"
              :key="agent.id"
              class="rounded-md border border-default bg-elevated p-5"
              :class="activeAgents.length === 1 ? 'xl:col-span-2' : undefined"
            >
              <div class="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <p class="flex items-center gap-2.5 font-mono text-sm">
                  <span class="live-dot size-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
                  <UIcon
                    :name="providerIcons[agent.provider]"
                    class="size-4 shrink-0 text-dimmed"
                    :aria-label="`${providerLabels[agent.provider]} agent`"
                  />
                  <span class="font-medium">{{ activeAgentRole(agent) }}</span>
                  <span class="text-dimmed" aria-hidden="true">·</span>
                  <span class="text-muted tabular-nums">{{ duration(agent.startedAt) }}</span>
                  <!-- Only appears once silence is long enough to mean something. -->
                  <template v-if="isProgressStalled(agent, now)">
                    <span class="text-dimmed" aria-hidden="true">·</span>
                    <span class="status-warning">{{ stalledLabel(agent, now) }}</span>
                  </template>
                </p>
                <div class="flex items-center gap-1">
                  <UButton
                    v-if="agent.session._tag === 'Connected'"
                    size="sm"
                    color="primary"
                    :variant="confirmingEject === agent.id ? 'solid' : 'ghost'"
                    icon="i-lucide-square-terminal"
                    :loading="ejectPending === agent.id"
                    :disabled="ejectPending !== undefined || cancelPending !== undefined"
                    :aria-label="confirmingEject === agent.id
                      ? `Confirm ejecting ${activeAgentRole(agent)} into an interactive terminal`
                      : `Eject ${activeAgentRole(agent)} into an interactive terminal`"
                    @click="requestEject(agent.id)"
                  >
                    {{ confirmingEject === agent.id ? 'Confirm eject' : 'Eject' }}
                  </UButton>
                  <UButton
                    size="sm"
                    color="error"
                    :variant="confirmingCancel === agent.id ? 'solid' : 'ghost'"
                    icon="i-lucide-circle-x"
                    :loading="cancelPending === agent.id"
                    :disabled="cancelPending !== undefined || ejectPending !== undefined"
                    :aria-label="confirmingCancel === agent.id
                      ? `Confirm cancelling the task for ${agent.repository} ${agent.subjectKind === 'issue' ? 'issue' : 'pull request'} ${agent.itemNumber}`
                      : `Cancel task for ${agent.repository} ${agent.subjectKind === 'issue' ? 'issue' : 'pull request'} ${agent.itemNumber}`"
                    @click="requestCancel(agent.id)"
                  >
                    {{ confirmingCancel === agent.id ? 'Confirm cancel' : 'Cancel' }}
                  </UButton>
                </div>
              </div>

              <a :href="agent.subjectUrl" target="_blank" rel="noreferrer" class="entity-link text-lg font-medium">
                {{ agent.title }}
                <span class="sr-only"> on GitHub</span>
              </a>
              <p class="mt-1.5 font-mono text-sm text-muted">
                <a :href="agent.repositoryUrl" target="_blank" rel="noreferrer" class="entity-link">{{ agent.repository }}</a>
                <span> · {{ agent.subjectKind === 'issue' ? 'Issue' : 'PR' }} #{{ agent.itemNumber }}</span>
              </p>

              <p class="mt-5 text-base">
                {{ activeAgentProgress(agent) }}
              </p>
              <div class="mt-2.5 flex items-center gap-3">
                <progress
                  class="min-w-0 flex-1"
                  :value="agent.progress.percent"
                  max="100"
                  :aria-label="`${activeAgentRole(agent)} progress`"
                />
                <span class="font-mono text-sm tabular-nums text-muted">{{ agent.progress.percent }}%</span>
              </div>

              <details v-if="agent.activity.length > 0" class="mt-4">
                <summary class="cursor-pointer font-mono text-sm text-dimmed">
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

              <details class="mt-4">
                <summary class="cursor-pointer font-mono text-sm text-dimmed">
                  Session and commit
                </summary>
                <dl class="mt-2 grid gap-1 font-mono text-sm text-muted">
                  <div class="flex items-center gap-2">
                    <dt class="sr-only">
                      Session
                    </dt>
                    <dd v-if="agent.session._tag === 'Starting'">
                      Session starting
                    </dd>
                    <dd v-else class="flex min-w-0 items-center gap-1">
                      <code class="min-w-0 truncate">{{ agent.session.id }}</code>
                      <UButton
                        v-if="clipboardSupported"
                        size="xs"
                        color="neutral"
                        variant="ghost"
                        icon="i-lucide-copy"
                        :aria-label="`Copy session ${agent.session.id}`"
                        @click="copySession(agent.session.id)"
                      >
                        {{ copiedSession === agent.session.id ? 'Copied' : 'Copy' }}
                      </UButton>
                    </dd>
                  </div>
                  <div v-if="agent.commitUrl && agent.headSha">
                    <dt class="sr-only">
                      Commit
                    </dt>
                    <dd>
                      <a :href="agent.commitUrl" target="_blank" rel="noreferrer" class="entity-link">Commit {{ agent.headSha.slice(0, 8) }}</a>
                    </dd>
                  </div>
                </dl>
              </details>

              <p v-if="cancelErrors[agent.id]" role="alert" class="status-error mt-3 text-sm">
                {{ cancelErrors[agent.id] }}
              </p>
              <p v-if="ejectErrors[agent.id]" role="alert" class="status-error mt-3 text-sm">
                {{ ejectErrors[agent.id] }}
              </p>
            </article>
          </div>

          <p v-else class="font-mono text-sm text-dimmed">
            No agents running.
          </p>
        </section>

        <!-- Zone 3: forecast. Low weight, scannable, no surface of its own. -->
        <section id="up-next" aria-labelledby="up-next-heading" class="mb-12 scroll-mt-20">
          <div class="zone-header">
            <h2 id="up-next-heading" class="field-label">
              Up next
            </h2>
            <span class="font-mono text-sm text-dimmed">{{ upNext.length }}</span>
            <hr class="zone-rule">
          </div>

          <ol v-if="upNext.length > 0" class="divide-y divide-default border-y border-default">
            <li
              v-for="entry in upNext"
              :key="`${entry.repository}:${entry.kind}:${entry.number}`"
              class="grid gap-x-4 gap-y-2 py-3 transition-colors hover:bg-muted/40 md:grid-cols-[2rem_minmax(0,1fr)_minmax(11rem,15rem)_6rem] md:items-center"
            >
              <span class="font-mono text-sm tabular-nums text-dimmed">{{ String(entry.position).padStart(2, '0') }}</span>
              <div class="min-w-0">
                <a :href="entry.subjectUrl" target="_blank" rel="noreferrer" class="entity-link text-sm font-medium">
                  {{ entry.title }}
                  <span class="sr-only"> on GitHub</span>
                </a>
                <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-sm text-dimmed">
                  <UAvatar :src="avatarUrl(entry.author)" :alt="entry.author" size="2xs" />
                  <a :href="entry.repositoryUrl" target="_blank" rel="noreferrer" class="entity-link">{{ entry.repository }}</a>
                  <span aria-hidden="true">·</span>
                  <a :href="entry.subjectUrl" target="_blank" rel="noreferrer" class="entity-link">{{ entry.kind === 'issue' ? 'Issue' : 'PR' }} #{{ entry.number }}</a>
                </div>
              </div>
              <div class="min-w-0">
                <UBadge
                  :color="queueStateTone(entry)"
                  :class="queueStateTone(entry) === 'neutral' ? undefined : statusClass(queueStateTone(entry))"
                  variant="subtle"
                >
                  {{ queueStateLabel(entry, queueContext) }}
                </UBadge>
                <p class="mt-1 line-clamp-2 text-sm text-muted">
                  {{ queueDetail(entry, queueContext) }}
                </p>
              </div>
              <div class="flex items-center md:justify-end">
                <UButton
                  v-if="queueTask(entry)"
                  size="sm"
                  color="error"
                  :variant="confirmingCancel === queueTask(entry)!.id ? 'solid' : 'ghost'"
                  icon="i-lucide-circle-x"
                  :loading="cancelPending === queueTask(entry)!.id"
                  :disabled="cancelPending !== undefined"
                  :aria-label="confirmingCancel === queueTask(entry)!.id
                    ? `Confirm cancelling the task for ${entry.repository} ${entry.kind === 'issue' ? 'issue' : 'pull request'} ${entry.number}`
                    : `Cancel task for ${entry.repository} ${entry.kind === 'issue' ? 'issue' : 'pull request'} ${entry.number}`"
                  @click="requestCancel(queueTask(entry)!.id)"
                >
                  {{ confirmingCancel === queueTask(entry)!.id ? 'Confirm cancel' : 'Cancel' }}
                </UButton>
                <UButton
                  v-else-if="entry.kind === 'pull_request' && entry.state._tag === 'Pending'"
                  size="sm"
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-rotate-cw"
                  :loading="rerunPending === rerunKey(entry.repository, entry.number, entry.revisionId)"
                  :disabled="rerunPending !== undefined"
                  :aria-label="`Rerun review for ${entry.repository} pull request ${entry.number}`"
                  @click="rerunReview(entry.repository, entry.number, entry.revisionId)"
                >
                  Rerun
                </UButton>
              </div>
              <p v-if="rerunErrors[rerunKey(entry.repository, entry.number, entry.revisionId)]" role="alert" class="status-error text-sm md:col-span-4">
                {{ rerunErrors[rerunKey(entry.repository, entry.number, entry.revisionId)] }}
              </p>
              <p v-if="queueTask(entry) && cancelErrors[queueTask(entry)!.id]" role="alert" class="status-error text-sm md:col-span-4">
                {{ cancelErrors[queueTask(entry)!.id] }}
              </p>
            </li>
          </ol>
          <p v-else class="font-mono text-sm text-dimmed">
            Nothing queued.
          </p>
        </section>

        <!-- Zone 4: what already happened, newest first. -->
        <section id="history" aria-labelledby="history-heading" class="deferred-section mb-12 scroll-mt-20">
          <div class="zone-header">
            <h2 id="history-heading" class="field-label">
              History
            </h2>
            <span class="font-mono text-sm text-dimmed">{{ history.length }}</span>
            <hr class="zone-rule">
          </div>

          <ol v-if="history.length > 0" class="divide-y divide-default border-y border-default">
            <li v-for="(record, index) in history" :id="record._tag === 'Review' ? `agent-${record.agent.id}` : undefined" :key="record.key">
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
                  <span class="text-sm">{{ taskKindLabel(record.task) }}</span>
                  <a :href="taskSubjectUrl(record.task)" target="_blank" rel="noreferrer" class="entity-link font-mono text-sm text-dimmed">
                    {{ record.task.repository }} · {{ taskIsIssue(record.task) ? 'Issue' : 'PR' }} #{{ taskNumber(record.task) }}
                  </a>
                </div>
                <p class="font-mono text-sm text-dimmed md:text-right">
                  {{ relativeTime(record.at) }}
                </p>
                <p v-if="taskStateDetail(record.task)" class="text-sm text-muted md:col-span-2">
                  {{ taskStateDetail(record.task) }}
                </p>
              </div>

              <article v-else>
                <div class="grid gap-x-4 gap-y-2 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <UBadge
                        :color="reviewOutcomeTone(record.agent)"
                        :class="statusClass(reviewOutcomeTone(record.agent))"
                        variant="subtle"
                      >
                        {{ reviewOutcomeLabel(record.agent) }}
                      </UBadge>
                      <a :href="record.agent.subjectUrl" target="_blank" rel="noreferrer" class="entity-link text-sm font-medium">
                        {{ record.agent.title }}
                        <span class="sr-only"> on GitHub</span>
                      </a>
                    </div>
                    <p class="mt-1 font-mono text-sm text-dimmed">
                      <a :href="record.agent.repositoryUrl" target="_blank" rel="noreferrer" class="entity-link">{{ record.agent.repository }}</a>
                      · PR #{{ record.agent.pullRequestNumber }} · {{ relativeTime(record.agent.completedAt) }} · took {{ duration(record.agent.startedAt, record.agent.completedAt) }}
                    </p>
                  </div>
                  <div class="flex flex-wrap items-center gap-1 md:justify-end">
                    <UButton
                      v-if="currentReviewSubject(record.agent)"
                      size="sm"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-rotate-cw"
                      :loading="rerunPending === rerunKey(record.agent.repository, record.agent.pullRequestNumber, record.agent.revisionId)"
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
                      :aria-expanded="isReviewExpanded(record.agent, index)"
                      :aria-controls="`agent-details-${record.agent.id}`"
                      trailing-icon="i-lucide-chevron-down"
                      :ui="{ trailingIcon: isReviewExpanded(record.agent, index) ? 'rotate-180 transition-transform' : 'transition-transform' }"
                      @click="toggleReview(record.agent, index)"
                    >
                      Evidence
                    </UButton>
                  </div>
                </div>

                <p v-if="rerunErrors[rerunKey(record.agent.repository, record.agent.pullRequestNumber, record.agent.revisionId)]" role="alert" class="status-error pb-3 text-sm">
                  {{ rerunErrors[rerunKey(record.agent.repository, record.agent.pullRequestNumber, record.agent.revisionId)] }}
                </p>

                <div
                  v-if="isReviewExpanded(record.agent, index)"
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
        </section>

        <!-- Zone 5: reference, not events. Recessive by design. -->
        <section id="watching" aria-labelledby="watching-heading" class="deferred-section scroll-mt-20">
          <div class="zone-header">
            <h2 id="watching-heading" class="field-label">
              Watching
            </h2>
            <span class="font-mono text-sm text-dimmed">{{ snapshot.repositories.length }} repositories · {{ snapshot.items.length }} open</span>
            <hr class="zone-rule">
          </div>

          <div class="grid items-start gap-x-10 gap-y-8 xl:grid-cols-2">
            <div class="min-w-0">
              <div class="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <h3 class="text-sm font-medium text-muted">
                  Repositories
                </h3>
                <UInput
                  v-model="repositoryQuery"
                  size="sm"
                  icon="i-lucide-search"
                  placeholder="Filter repositories"
                  aria-label="Filter repositories"
                  class="w-full sm:w-56"
                />
              </div>

              <div class="max-h-[26rem] overflow-auto border-y border-default">
                <table v-if="filteredRepositories.length > 0" class="w-full min-w-[42rem] border-collapse text-left">
                  <caption class="sr-only">
                    Repository health and latest poll state
                  </caption>
                  <thead class="sticky top-0 z-10 border-b border-default bg-default">
                    <tr class="field-label">
                      <th scope="col" class="py-2 pr-4">
                        Repository
                      </th>
                      <th scope="col" class="py-2 pr-4">
                        Health
                      </th>
                      <th scope="col" class="py-2 pr-4 text-right">
                        Open
                      </th>
                      <th scope="col" class="py-2 pr-4">
                        Authority
                      </th>
                      <th scope="col" class="py-2 pr-4">
                        Agents
                      </th>
                      <th scope="col" class="py-2">
                        Last success
                      </th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-default">
                    <tr v-for="repository in filteredRepositories" :key="repository.github" class="transition-colors hover:bg-muted/40">
                      <th scope="row" class="whitespace-nowrap py-2.5 pr-4 font-mono text-sm font-normal">
                        <a :href="`https://github.com/${repository.github}`" target="_blank" rel="noreferrer" class="entity-link">{{ repository.github }}</a>
                      </th>
                      <td class="py-2.5 pr-4">
                        <UBadge
                          :color="repositoryState(repository).tone"
                          :class="statusClass(repositoryState(repository).tone)"
                          variant="subtle"
                        >
                          {{ repositoryState(repository).label }}
                        </UBadge>
                      </td>
                      <td class="py-2.5 pr-4 text-right font-mono text-sm tabular-nums">
                        <a :href="`https://github.com/${repository.github}/issues`" target="_blank" rel="noreferrer" class="entity-link">{{ repository.subjectCount }}</a>
                      </td>
                      <td class="py-2.5 pr-4 font-mono text-sm text-dimmed">
                        {{ repository.ownership }}
                      </td>
                      <td class="py-2.5 pr-4">
                        <UButton
                          size="xs"
                          color="neutral"
                          variant="ghost"
                          :icon="repository.paused ? 'i-lucide-play' : 'i-lucide-pause'"
                          :loading="repositoryPending === repository.github"
                          :disabled="repositoryPending !== undefined"
                          :aria-label="repository.paused
                            ? `Resume agents for ${repository.github}`
                            : `Pause agents for ${repository.github}`"
                          @click="setRepositoryPaused(repository.github, !repository.paused)"
                        >
                          {{ repository.paused ? 'Paused' : 'Running' }}
                        </UButton>
                      </td>
                      <td class="py-2.5 font-mono text-sm text-dimmed">
                        {{ relativeTime(repository.lastSuccessAt) }}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p v-else class="py-6 font-mono text-sm text-dimmed">
                  No repository mappings. The agent is waiting for an installed repository with a trusted checkout.
                </p>
              </div>
            </div>

            <div class="min-w-0">
              <div class="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <h3 class="text-sm font-medium text-muted">
                  Open pull requests and issues
                </h3>
                <div class="flex items-center gap-1" aria-label="Filter pull requests and issues">
                  <UButton
                    v-for="filter in [
                      { label: 'All', value: 'all' as const },
                      { label: 'PRs', value: 'pull_request' as const },
                      { label: 'Issues', value: 'issue' as const },
                    ]"
                    :key="filter.value"
                    size="sm"
                    :color="subjectFilter === filter.value ? 'primary' : 'neutral'"
                    :variant="subjectFilter === filter.value ? 'soft' : 'ghost'"
                    :aria-pressed="subjectFilter === filter.value"
                    @click="subjectFilter = filter.value"
                  >
                    {{ filter.label }}
                  </UButton>
                </div>
              </div>

              <div class="max-h-[26rem] overflow-auto border-y border-default">
                <ul v-if="filteredSubjects.length > 0" class="divide-y divide-default" role="list">
                  <li v-for="subject in filteredSubjects" :key="`${subject.repository}:${subject.kind}:${subject.number}`" class="py-2.5 transition-colors hover:bg-muted/40">
                    <a :href="subject.url" target="_blank" rel="noreferrer" class="entity-link text-sm">{{ subject.title }}</a>
                    <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-sm text-dimmed">
                      <UAvatar :src="avatarUrl(subject.author)" :alt="subject.author" size="2xs" />
                      <a :href="`https://github.com/${subject.repository}`" target="_blank" rel="noreferrer" class="entity-link">{{ subject.repository }}</a>
                      <span aria-hidden="true">·</span>
                      <a :href="subject.url" target="_blank" rel="noreferrer" class="entity-link">{{ subjectKind(subject) }} #{{ subject.number }}</a>
                      <span aria-hidden="true">·</span>
                      <span>{{ relativeTime(subject.observedAt) }}</span>
                    </div>
                  </li>
                </ul>
                <p v-else class="py-6 font-mono text-sm text-dimmed">
                  No open pull requests or issues. The agent is waiting for a human issue or pull request.
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>

    <footer class="mx-auto flex max-w-[90rem] flex-wrap gap-x-6 gap-y-1 px-4 pb-10 pt-12 font-mono text-sm text-dimmed sm:px-6 lg:px-8">
      <span v-for="[role, label] in agentRoleLabels" :key="role">
        {{ label }}: {{ snapshot.agentProfile.roles[role].model }}<template v-if="snapshot.agentProfile.roles[role].reasoningEffort"> · {{ snapshot.agentProfile.roles[role].reasoningEffort }}</template>
      </span>
      <span class="inline-flex items-center gap-1.5">
        <UIcon :name="providerIcons[activeProvider]" class="size-4 shrink-0" aria-hidden="true" />
        {{ providerLabels[activeProvider] }} · {{ snapshot.agentProfile.maximumActiveAgents }} agents max
      </span>
      <span>Loopback only · GitHub App scoped · Repository tokens isolated</span>
      <span><kbd>j</kbd> <kbd>k</kbd> move decisions · <kbd>a</kbd> approve · <kbd>/</kbd> filter repositories</span>
    </footer>
  </div>
</template>
