import type {
  ActiveAgent,
  AgentSelection,
  AgentTask,
  DashboardSnapshot,
  ItemSummary,
  QueueEntry,
  ReviewAgent,
  SelectionMode,
} from '../../../src/types.ts'
import { formatTimeAgo, useDocumentVisibility, useEventSource, useNow } from '@vueuse/core'
import { CODEX_AGENT_PROFILE } from '../../../src/agent-profile.ts'
import {
  decisionEntries,
  isSnapshotStale,
  taskNumber,
} from '../utils/dashboard.ts'

function emptySnapshot(): DashboardSnapshot {
  return {
    generatedAt: '',
    status: 'starting',
    mutationsEnabled: false,
    agentControl: { _tag: 'Running' },
    selectionMode: 'auto',
    openPullRequests: 0,
    maxOpenPullRequests: 8,
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

/**
 * One live snapshot for every page.
 *
 * The scope is detached and created once, so moving between the board, History,
 * and Watching keeps a single event stream instead of opening one per page.
 */
function createDashboard() {
  const snapshot = shallowRef<DashboardSnapshot>(emptySnapshot())
  const loading = ref(true)
  const loadError = ref<string>()
  const controlPending = ref(false)
  const controlError = ref<string>()

  const approvalPending = ref<string>()
  const approvalErrors = ref<Record<string, string>>({})
  const cancelPending = ref<string>()
  const cancelErrors = ref<Record<string, string>>({})
  const ejectPending = ref<string>()
  const ejectErrors = ref<Record<string, string>>({})
  const rerunPending = ref<string>()
  const rerunErrors = ref<Record<string, string>>({})
  const repositoryPending = ref<string>()
  const dismissPending = ref<string>()
  const dismissErrors = ref<Record<string, string>>({})

  const visibility = useDocumentVisibility()
  const now = useNow({ interval: 1_000 })

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
  const decisions = computed(() => decisionEntries(snapshot.value.queue))
  const unhealthyRepositories = computed(() => snapshot.value.repositories.filter(repository => repository.lastError !== null).length)
  const queueContext = computed(() => ({
    agentsCanStart: agentsCanStart.value,
    agentsPaused: snapshot.value.agentControl._tag === 'Paused',
    openPullRequests: snapshot.value.openPullRequests,
    maxOpenPullRequests: snapshot.value.maxOpenPullRequests,
    selectionMode: snapshot.value.selectionMode,
  }))

  const connectionLabel = computed(() => {
    if (liveStatus.value === 'OPEN')
      return 'Live'
    return liveError.value !== null ? 'Reconnecting' : 'Connecting'
  })

  /** Old data on a monitoring surface is worse than none, because it still looks authoritative. */
  const isStale = computed(() => !loading.value && isSnapshotStale(snapshot.value.generatedAt, now.value))

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

  function failed(error: unknown): string {
    return error instanceof Error ? error.message : 'The request failed.'
  }

  function without(errors: Record<string, string>, key: string): Record<string, string> {
    return Object.fromEntries(Object.entries(errors).filter(([candidate]) => candidate !== key))
  }

  /** Every control writes through the controller, then reloads rather than guessing the result. */
  async function control(request: () => Promise<unknown>): Promise<void> {
    controlPending.value = true
    controlError.value = undefined
    return request()
      .then(() => loadState())
      .catch((error: unknown) => {
        controlError.value = failed(error)
      })
      .finally(() => {
        controlPending.value = false
      })
  }

  const setAgentControl = (action: 'pause' | 'resume'): Promise<void> =>
    control(() => $fetch(`/api/agents/${action}`, { method: 'POST' }))

  const setSelectionMode = (mode: SelectionMode): Promise<void> =>
    control(() => $fetch('/api/agents/selection-mode', { method: 'POST', body: { mode } }))

  /** A switch starts the next agent turn. Work already running keeps its model. */
  const switchAgent = (selection: AgentSelection): Promise<void> =>
    control(() => $fetch('/api/agents/select', { method: 'POST', body: selection }))

  async function setRepositoryPaused(repository: string, paused: boolean): Promise<void> {
    repositoryPending.value = repository
    controlError.value = undefined
    return $fetch(`/api/repositories/${paused ? 'pause' : 'resume'}`, { method: 'POST', body: { repository } })
      .then(() => loadState())
      .catch((error: unknown) => {
        controlError.value = failed(error)
      })
      .finally(() => {
        repositoryPending.value = undefined
      })
  }

  function itemKey(repository: string, number: number, revisionId: string): string {
    return `${repository}:${number}:${revisionId}`
  }

  async function rerunReview(repository: string, pullRequestNumber: number, revisionId: string): Promise<void> {
    const key = itemKey(repository, pullRequestNumber, revisionId)
    rerunPending.value = key
    rerunErrors.value = without(rerunErrors.value, key)
    return $fetch('/api/reviews/rerun', { method: 'POST', body: { repository, pullRequestNumber, revisionId } })
      .then(() => loadState())
      .catch((error: unknown) => {
        rerunErrors.value = { ...rerunErrors.value, [key]: `${failed(error)} Refresh and retry.` }
      })
      .finally(() => {
        rerunPending.value = undefined
      })
  }

  async function cancelAgentTask(taskId: string): Promise<void> {
    cancelPending.value = taskId
    cancelErrors.value = without(cancelErrors.value, taskId)
    return $fetch('/api/tasks/cancel', { method: 'POST', body: { taskId } })
      .then(() => loadState())
      .catch((error: unknown) => {
        cancelErrors.value = { ...cancelErrors.value, [taskId]: `${failed(error)} Refresh and retry.` }
      })
      .finally(() => {
        cancelPending.value = undefined
      })
  }

  async function ejectAgent(taskId: string): Promise<void> {
    ejectPending.value = taskId
    ejectErrors.value = without(ejectErrors.value, taskId)
    return $fetch('/api/agents/eject', { method: 'POST', body: { taskId } })
      .then(() => loadState())
      .catch((error: unknown) => {
        ejectErrors.value = { ...ejectErrors.value, [taskId]: failed(error) }
      })
      .finally(() => {
        ejectPending.value = undefined
      })
  }

  async function approveQueueEntry(entry: QueueEntry): Promise<void> {
    if (entry.state._tag !== 'AwaitingApproval')
      return
    const key = itemKey(entry.repository, entry.number, entry.revisionId)
    approvalPending.value = `${key}:${entry.state.kind}`
    approvalErrors.value = without(approvalErrors.value, key)
    const request = entry.state.kind === 'issue_work'
      ? $fetch('/api/issues/approve', {
          method: 'POST',
          body: { repository: entry.repository, issueNumber: entry.number, revisionId: entry.revisionId },
        })
      : $fetch('/api/approvals', {
          method: 'POST',
          body: {
            repository: entry.repository,
            pullRequestNumber: entry.number,
            revisionId: entry.revisionId,
            kind: entry.state.kind,
          },
        })
    return request
      .then(() => loadState())
      .catch((error: unknown) => {
        approvalErrors.value = { ...approvalErrors.value, [key]: `${failed(error)} Refresh and retry.` }
      })
      .finally(() => {
        approvalPending.value = undefined
      })
  }

  function approvalKeyFor(entry: QueueEntry): string {
    if (entry.state._tag !== 'AwaitingApproval')
      return ''
    return `${itemKey(entry.repository, entry.number, entry.revisionId)}:${entry.state.kind}`
  }

  function approvalErrorFor(entry: QueueEntry): string | undefined {
    return approvalErrors.value[itemKey(entry.repository, entry.number, entry.revisionId)]
  }

  /** The live Task behind a Queue entry, which is what Cancel acts on. */
  function taskFor(entry: QueueEntry): AgentTask | undefined {
    return snapshot.value.tasks.find(task =>
      task.repository === entry.repository
      && taskNumber(task) === entry.number
      && task.revisionId === entry.revisionId
      && task.state._tag !== 'Completed'
      && task.state._tag !== 'Superseded',
    )
  }

  /**
   * A Dismissal names the Item, so one call covers every future head commit.
   */
  async function changeDismissal(repository: string, itemNumber: number, action: 'dismiss' | 'restore'): Promise<void> {
    const key = `${repository}#${itemNumber}`
    dismissPending.value = key
    dismissErrors.value = without(dismissErrors.value, key)
    return $fetch(`/api/items/${action}`, { method: 'POST', body: { repository, itemNumber } })
      .then(() => loadState())
      .catch((error: unknown) => {
        dismissErrors.value = { ...dismissErrors.value, [key]: `${failed(error)} Refresh and retry.` }
      })
      .finally(() => {
        dismissPending.value = undefined
      })
  }

  const dismissItem = (repository: string, itemNumber: number): Promise<void> =>
    changeDismissal(repository, itemNumber, 'dismiss')

  const restoreItem = (repository: string, itemNumber: number): Promise<void> =>
    changeDismissal(repository, itemNumber, 'restore')

  function dismissKey(repository: string, itemNumber: number): string {
    return `${repository}#${itemNumber}`
  }

  function pullRequestFor(entry: QueueEntry) {
    if (entry.kind !== 'pull_request')
      return undefined
    return snapshot.value.items.find(subject =>
      subject.kind === 'pull_request'
      && subject.repository === entry.repository
      && subject.number === entry.number
      && subject.revisionId === entry.revisionId,
    )
  }

  /**
   * Whether the controller would accept a review run for this pull request.
   *
   * Mirrors the store's own refusal rules, so the board never offers a control
   * that is certain to fail.
   */
  function canRunReview(entry: QueueEntry): boolean {
    const pullRequest = pullRequestFor(entry)
    if (pullRequest === undefined || pullRequest.kind !== 'pull_request')
      return false
    return pullRequest.state === 'open'
      && !pullRequest.draft
      && pullRequest.mergeState === 'clean'
      && pullRequest.approval._tag !== 'ReviewRequired'
  }

  /** A review can only be rerun while its pull request is still the current one. */
  function isCurrentRevision(agent: ReviewAgent): boolean {
    return snapshot.value.items.some((subject: ItemSummary) =>
      subject.kind === 'pull_request'
      && subject.repository === agent.repository
      && subject.number === agent.pullRequestNumber
      && subject.revisionId === agent.revisionId,
    )
  }

  function start(): void {
    void loadState()
    if (visibility.value === 'visible')
      openLiveUpdates()
  }

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

  return {
    snapshot,
    loading,
    loadError,
    controlPending,
    controlError,
    approvalPending,
    approvalErrors,
    cancelPending,
    cancelErrors,
    ejectPending,
    ejectErrors,
    rerunPending,
    rerunErrors,
    repositoryPending,
    dismissPending,
    dismissErrors,
    dismissItem,
    restoreItem,
    dismissKey,
    now,
    activeAgents,
    reviewAgents,
    agentsCanStart,
    decisions,
    unhealthyRepositories,
    queueContext,
    connectionLabel,
    liveStatus,
    isStale,
    relativeTime,
    duration,
    loadState,
    start,
    setAgentControl,
    setSelectionMode,
    switchAgent,
    setRepositoryPaused,
    rerunReview,
    cancelAgentTask,
    ejectAgent,
    approveQueueEntry,
    approvalKeyFor,
    approvalErrorFor,
    taskFor,
    pullRequestFor,
    canRunReview,
    isCurrentRevision,
    itemKey,
  }
}

type Dashboard = ReturnType<typeof createDashboard>

let dashboard: Dashboard | undefined

// The reactivity lives in createDashboard, inside a scope this owns for the app's lifetime.
// eslint-disable-next-line harlanzw/vue-no-faux-composables
export function useDashboard(): Dashboard {
  if (dashboard === undefined) {
    // A detached scope keeps the watchers and the event stream alive across
    // page changes, instead of tearing them down with the first page to unmount.
    dashboard = effectScope(true).run(createDashboard) as Dashboard
  }
  return dashboard
}
