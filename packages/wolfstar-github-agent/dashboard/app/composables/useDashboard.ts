import type {
  ActiveAgent,
  AgentFeedbackInput,
  AgentSelection,
  AgentTask,
  DashboardSnapshot,
  ItemSummary,
  PinnedAgentSelection,
  QueueEntry,
  ReviewAgent,
  RoutineRun,
  SelectionMode,
} from '../../../src/types.ts'
import { createSharedComposable, formatTimeAgo, useDocumentVisibility, useEventSource, useNow } from '@vueuse/core'
import { CODEX_AGENT_PROFILE } from '../../../src/agent-profile.ts'
import {
  agentStartState,
  humanDecisionEntries,
  incidentEntries,
  isSnapshotStale,
  serviceClockOffset,
  taskNumber,
} from '../utils/dashboard.ts'

function emptySnapshot(): DashboardSnapshot {
  return {
    generatedAt: '',
    status: 'starting',
    mutationsEnabled: false,
    agentControl: { _tag: 'Running' },
    restartRequest: null,
    serviceUpdate: { _tag: 'Checking', deployedCommit: '' },
    selectionMode: 'auto',
    openPullRequests: 0,
    maxOpenPullRequests: 8,
    agentProfile: CODEX_AGENT_PROFILE,
    agentSelection: { _tag: 'FollowsConfiguration' },
    agentStart: { _tag: 'WritesDisabled' },
    agentProviderOrder: ['opencode', 'codex'],
    agentModels: { codex: [], opencode: [] },
    reasoningEfforts: [],
    providerCapacities: [],
    githubRateLimits: [],
    providerCircuits: [],
    agents: [],
    incidents: [],
    repairRecoveryCandidates: [],
    queue: [],
    repositories: [],
    items: [],
    tasks: [],
    routines: [],
    routineRuns: [],
    batches: [],
  }
}

/**
 * One live snapshot for every page.
 *
 * The scope is detached and created once, so moving between the board, History,
 * and Watching keeps a single event stream instead of opening one per page.
 */
function createDashboard() {
  const { readOnly, controllerPath } = useTerminalHost()
  let started = false
  const snapshot = shallowRef<DashboardSnapshot>(emptySnapshot())
  const loading = ref(true)
  const loadError = ref<string>()
  const controlPending = ref(false)
  const controlError = ref<string>()

  const approvalPending = ref<string>()
  const approvalErrors = ref<Record<string, string>>({})
  const cancelPending = ref<string>()
  const cancelErrors = ref<Record<string, string>>({})
  const rerunPending = ref<string>()
  const rerunErrors = ref<Record<string, string>>({})
  const feedbackPending = ref<string>()
  const feedbackErrors = ref<Record<string, string>>({})
  const repositoryPending = ref<string>()
  const dismissPending = ref<string>()
  const dismissErrors = ref<Record<string, string>>({})

  const visibility = useDocumentVisibility()
  const browserNow = useNow({ interval: 1_000 })
  const clockOffset = ref(0)
  const now = computed(() => new Date(browserNow.value.getTime() + clockOffset.value))

  const {
    data: liveSnapshot,
    open: openLiveUpdates,
    close: closeLiveUpdates,
  } = useEventSource<['state'], DashboardSnapshot>(
    computed(() => controllerPath('/api/events')),
    ['state'],
    {
      immediate: false,
      autoReconnect: { delay: 1_500 },
      serializer: { read: (value) => JSON.parse(value ?? '{}') as DashboardSnapshot },
    },
  )

  const activeAgents = computed(() =>
    snapshot.value.agents.filter((agent): agent is ActiveAgent => agent._tag === 'ActiveAgent'),
  )
  const reviewAgents = computed(() =>
    snapshot.value.agents.filter((agent): agent is ReviewAgent => agent._tag === 'ReviewAgent'),
  )
  const agentStart = computed(() => agentStartState(snapshot.value))
  const decisions = computed(() => humanDecisionEntries(snapshot.value))
  /** Errors first, then newest. The chip, the Incident row, and the pane all read this one order. */
  const incidents = computed(() => incidentEntries(snapshot.value.incidents))
  const unhealthyRepositories = computed(
    () => snapshot.value.repositories.filter((repository) => repository.lastError !== null).length,
  )
  const queueContext = computed(() => ({
    agentStart: agentStart.value,
    openPullRequests: snapshot.value.openPullRequests,
    maxOpenPullRequests: snapshot.value.maxOpenPullRequests,
    selectionMode: snapshot.value.selectionMode,
  }))

  /** Old data on a monitoring surface is worse than none, because it still looks authoritative. */
  const isStale = computed(() => !loading.value && isSnapshotStale(snapshot.value.generatedAt, now.value))
  const controlsUnavailable = computed(
    () => readOnly.value || loading.value || snapshot.value.generatedAt.length === 0 || isStale.value,
  )

  function refuseUnavailableControl(): boolean {
    if (!controlsUnavailable.value) return false
    controlError.value = readOnly.value
      ? 'Read-only Service connection.'
      : 'Service data is unavailable. Reload before changing settings or work.'
    return true
  }

  function relativeTime(value: string | null): string {
    return value === null || value.length === 0 ? 'Never' : formatTimeAgo(new Date(value), {}, now.value)
  }

  function duration(startedAt: string, completedAt?: string): string {
    const end = completedAt === undefined ? now.value.getTime() : new Date(completedAt).getTime()
    const seconds = Math.max(0, Math.floor((end - new Date(startedAt).getTime()) / 1_000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    return seconds < 3_600 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  }

  async function loadState(): Promise<void> {
    loadError.value = undefined
    return $fetch
      .raw<DashboardSnapshot>(controllerPath('/api/state'))
      .then((response) => {
        if (response._data === undefined) throw new Error('The Service returned no state.')
        clockOffset.value = serviceClockOffset(response.headers.get('date'), new Date())
        snapshot.value = response._data
      })
      .catch((error: unknown) => {
        loadError.value =
          error instanceof Error
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
    if (refuseUnavailableControl()) return
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

  const requestRestart = (): Promise<void> =>
    control(() => $fetch('/api/service/restart', { method: 'POST', body: { source: 'dashboard' } }))

  const requestUpdate = (): Promise<void> =>
    control(() => $fetch('/api/service/update', { method: 'POST', body: { source: 'dashboard' } }))

  /** A switch starts the next agent turn. Work already running keeps its model. */
  const selectAgent = (selection: AgentSelection): Promise<void> =>
    control(() => $fetch('/api/agents/select', { method: 'POST', body: selection }))

  async function runRoutine(routineId: string, agentSelection: PinnedAgentSelection): Promise<RoutineRun | undefined> {
    if (refuseUnavailableControl()) return undefined
    const run = await $fetch<RoutineRun>('/api/routines/run', { method: 'POST', body: { routineId, agentSelection } })
    await loadState()
    return run
  }

  /** Agent slots apply to the next turn. Running Agents finish. */
  const setAgentSlots = (host: 'hogwild' | 'desktop', slots: number): Promise<void> =>
    control(() => $fetch('/api/agents/slots', { method: 'POST', body: { host, slots } }))

  async function setRepositoryPaused(repository: string, paused: boolean): Promise<void> {
    if (refuseUnavailableControl()) return
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

  async function setRepositoryWritesEnabled(repository: string, writesEnabled: boolean): Promise<void> {
    if (refuseUnavailableControl()) return
    repositoryPending.value = repository
    controlError.value = undefined
    return $fetch(`/api/repositories/writes/${writesEnabled ? 'enable' : 'disable'}`, {
      method: 'POST',
      body: { repository },
    })
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
    if (refuseUnavailableControl()) return
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

  async function recordAgentFeedback(reviewRunId: string, feedback: AgentFeedbackInput): Promise<void> {
    if (refuseUnavailableControl()) return
    feedbackPending.value = reviewRunId
    feedbackErrors.value = without(feedbackErrors.value, reviewRunId)
    return $fetch('/api/reviews/feedback', { method: 'POST', body: { reviewRunId, feedback } })
      .then(() => loadState())
      .catch((error: unknown) => {
        feedbackErrors.value = { ...feedbackErrors.value, [reviewRunId]: failed(error) }
      })
      .finally(() => {
        feedbackPending.value = undefined
      })
  }

  async function cancelAgentTask(taskId: string): Promise<void> {
    if (refuseUnavailableControl()) return
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

  async function approveQueueEntry(entry: QueueEntry): Promise<void> {
    if (refuseUnavailableControl()) return
    if (entry.state._tag !== 'AwaitingApproval') return
    const key = itemKey(entry.repository, entry.number, entry.revisionId)
    approvalPending.value = `${key}:${entry.state.kind}`
    approvalErrors.value = without(approvalErrors.value, key)
    const request =
      entry.state.kind !== 'review'
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
    if (entry.state._tag !== 'AwaitingApproval') return ''
    return `${itemKey(entry.repository, entry.number, entry.revisionId)}:${entry.state.kind}`
  }

  function approvalErrorFor(entry: QueueEntry): string | undefined {
    return approvalErrors.value[itemKey(entry.repository, entry.number, entry.revisionId)]
  }

  /** The live Task behind a Queue entry, which is what Cancel acts on. */
  function taskFor(entry: QueueEntry): AgentTask | undefined {
    return snapshot.value.tasks.find(
      (task) =>
        task.repository === entry.repository &&
        taskNumber(task) === entry.number &&
        task.revisionId === entry.revisionId &&
        task.state._tag !== 'Completed' &&
        task.state._tag !== 'Superseded',
    )
  }

  /**
   * A Dismissal names the Item, so one call covers every future head commit.
   */
  async function changeDismissal(repository: string, itemNumber: number, action: 'dismiss' | 'restore'): Promise<void> {
    if (refuseUnavailableControl()) return
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
    if (entry.kind !== 'pull_request') return undefined
    return snapshot.value.items.find(
      (subject) =>
        subject.kind === 'pull_request' &&
        subject.repository === entry.repository &&
        subject.number === entry.number &&
        subject.revisionId === entry.revisionId,
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
    if (pullRequest === undefined || pullRequest.kind !== 'pull_request') return false
    return (
      pullRequest.state === 'open' &&
      !pullRequest.draft &&
      pullRequest.mergeState === 'clean' &&
      pullRequest.approval._tag !== 'ReviewRequired'
    )
  }

  /** A review can only be rerun while its pull request is still the current one. */
  function isCurrentRevision(agent: ReviewAgent): boolean {
    return snapshot.value.items.some(
      (subject: ItemSummary) =>
        subject.kind === 'pull_request' &&
        subject.repository === agent.repository &&
        subject.number === agent.pullRequestNumber &&
        subject.revisionId === agent.revisionId,
    )
  }

  function start(): void {
    if (started) return
    started = true
    void loadState()
    if (visibility.value === 'visible') openLiveUpdates()
  }

  watch(liveSnapshot, (value) => {
    if (value !== null) {
      snapshot.value = value
      loading.value = false
    }
  })

  watch(visibility, (value) => {
    if (!started) return
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
    rerunPending,
    rerunErrors,
    feedbackPending,
    feedbackErrors,
    repositoryPending,
    dismissPending,
    dismissErrors,
    dismissItem,
    restoreItem,
    dismissKey,
    now,
    activeAgents,
    reviewAgents,
    agentStart,
    decisions,
    incidents,
    unhealthyRepositories,
    queueContext,
    isStale,
    controlsUnavailable,
    relativeTime,
    duration,
    loadState,
    start,
    setAgentControl,
    requestRestart,
    requestUpdate,
    setSelectionMode,
    selectAgent,
    runRoutine,
    setAgentSlots,
    setRepositoryPaused,
    setRepositoryWritesEnabled,
    rerunReview,
    recordAgentFeedback,
    cancelAgentTask,
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

/**
 * Shared by every page. The first caller creates the detached scope, so moving
 * between the board, History, and Watching keeps one event stream instead of
 * tearing it down with the first page to unmount. The layout subscribes for the
 * app's lifetime, so the scope never disposes while the app is open.
 */
export const useDashboard = createSharedComposable(createDashboard)
