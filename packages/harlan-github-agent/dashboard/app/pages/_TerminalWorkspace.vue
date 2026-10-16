<script setup lang="ts">
import type { TerminalCapabilities, TerminalProject, TerminalProvider, TerminalScreen, TerminalSession } from '../../../src/terminal-protocol.ts'
import type { TerminalCapacity } from '../utils/terminal-capacity.ts'
import type { TerminalLaunchIntent } from '../utils/terminal-launch.ts'
import type { TerminalSubmission } from '../utils/terminal-submission.ts'
import { useDocumentVisibility, useEventListener, useIntervalFn, useMediaQuery, useSessionStorage, useStorage } from '@vueuse/core'
import { parseTerminalCapacity } from '../utils/terminal-capacity.ts'
import { terminalFailureCopy } from '../utils/terminal-copy.ts'
import { createTerminalDraftStore } from '../utils/terminal-draft.ts'
import { terminalLaunchIntent } from '../utils/terminal-launch.ts'
import { activeTerminalSession, emptyTerminalLayout, emptyTerminalProjectLayout, parseTerminalLayout, reconcileTerminalLayout, terminalDisplayProjects, updateTerminalProjectLayout } from '../utils/terminal-layout.ts'
import { terminalProjectGroups } from '../utils/terminal-project-groups.ts'
import { parseTerminalProjects, parseTerminalSessionResult, parseTerminalSessions } from '../utils/terminal-protocol.ts'
import TerminalView from './_TerminalView.vue'

const { capabilities } = defineProps<{ capabilities: TerminalCapabilities }>()
const savedDrafts = useSessionStorage(`agent-terminal-drafts:${capabilities.hostId}`, new Map<string, string>())
const drafts = createTerminalDraftStore(savedDrafts.value)
const screens = useState<Record<string, TerminalScreen>>(`agent-terminal-screens:${capabilities.hostId}`, () => ({}))
function screenKey(session: TerminalSession) {
  return JSON.stringify([session.id, session.generation])
}
function cacheScreen(session: TerminalSession, screen: TerminalScreen) {
  const entries = Object.entries(screens.value).filter(([key]) => key !== screenKey(session)).slice(-9)
  screens.value = Object.fromEntries([...entries, [screenKey(session), markRaw(screen)]])
}
const memories = useSessionStorage<Record<string, { submission: TerminalSubmission, reading: { snapshot?: string, offset: number, top: number } | null }>>(`agent-terminal-reading:${capabilities.hostId}`, {})
function memory(session: TerminalSession) {
  const key = JSON.stringify([session.id, session.generation])
  return memories.value[key] ??= { submission: { _tag: 'Editing' }, reading: null }
}

// Diff rendering stays outside the terminal bundle until the user opens it.
const TerminalDiff = defineAsyncComponent(() => import('../components/_TerminalDiff.vue'))

const route = useRoute()
const projects = shallowRef<TerminalProject[]>([])
const sessions = shallowRef<TerminalSession[]>([])
const displayProjects = computed(() => terminalDisplayProjects(projects.value, sessions.value))
const capacity = shallowRef<TerminalCapacity>({ _tag: 'Unavailable' })
const filter = ref('')
const showAllProjects = ref(false)
const projectVisits = useStorage<unknown>(`agent-terminal-project-visits:${capabilities.hostId}`, {}, undefined, { initOnMounted: true })
const storedLayout = useStorage<unknown>(`agent-terminal-layout:${capabilities.hostId}`, emptyTerminalLayout(), undefined, { initOnMounted: true })
const layout = computed(() => {
  const parsed = parseTerminalLayout(storedLayout.value)
  return parsed._tag === 'Ok' ? parsed.value : emptyTerminalLayout()
})
const projectId = computed({ get: () => layout.value.projectId, set: (value) => {
  storedLayout.value = { ...layout.value, projectId: value }
} })
const projectLayout = computed(() => Object.hasOwn(layout.value.projects, projectId.value) ? layout.value.projects[projectId.value]! : emptyTerminalProjectLayout())
const narrow = useMediaQuery('(max-width: 1023px)')
const projectsOpen = ref(false)
const launchOpen = ref(false)
const projectFilter = useTemplateRef<{ inputRef?: HTMLInputElement }>('projectFilter')
const stopConfirm = ref(false)
const stopTarget = ref('')
const tabList = useTemplateRef<HTMLElement>('tabList')
const terminalArea = useTemplateRef<HTMLElement>('terminalArea')
const provider = ref<TerminalProvider>('codex')
const initialDrafts = useSessionStorage<Record<string, string>>(`agent-terminal-initial:${capabilities.hostId}`, {})
const initialPrompt = computed({
  get: () => initialDrafts.value[projectId.value] ?? '',
  set: (value: string) => {
    initialDrafts.value[projectId.value] = value
  },
})
const forceConfirmation = shallowRef<{ _tag: 'New' } | { _tag: 'Waiting', id: string }>()
const forceAttempts = new Map<string, string>()
const failure = ref('')
const pending = ref(false)
const loading = ref(true)
const refreshing = ref(false)
const visibility = useDocumentVisibility()
const diffOpen = ref(false)
const launchIntent = shallowRef<TerminalLaunchIntent>()
const selectedId = computed(() => activeTerminalSession(projectLayout.value))
const selected = computed(() => sessions.value.find(session => session.id === selectedId.value))
const tabSessions = computed(() => projectLayout.value.tabs.map(id => sessions.value.find(session => session.id === id)).filter((session): session is TerminalSession => session !== undefined))
const visibleSessions = computed(() => {
  const view = projectLayout.value.view
  const ids = view._tag === 'Empty' ? [] : view._tag === 'Single' || narrow.value ? [selectedId.value] : [view.left, view.right]
  return ids.map(id => sessions.value.find(session => session.id === id)).filter((session): session is TerminalSession => session !== undefined)
})
function sessionLabel(session: TerminalSession) {
  return `${providerNames[session.provider]} ${new Date(session.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}
function sessionState(session: TerminalSession) {
  return session.state === 'Queued' ? 'Waiting to start' : session.state === 'Cancelled' ? 'Session cancelled.' : session.state
}
function projectSessions(id: string) {
  const query = filter.value.toLowerCase().trim()
  const project = displayProjects.value.find(project => project.id === id)
  return sessions.value.filter(session => session.projectId === id && `${project?.name} ${sessionLabel(session)} ${sessionState(session)}`.toLowerCase().includes(query))
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
}
const visibleProjects = computed(() => displayProjects.value.filter(project => project.name.toLowerCase().includes(filter.value.toLowerCase().trim()) || projectSessions(project.id).length > 0))
const projectGroups = computed(() => terminalProjectGroups({
  projects: visibleProjects.value,
  sessions: sessions.value,
  visited: projectVisits.value,
  now: Date.now(),
  all: showAllProjects.value || Boolean(filter.value.trim()),
  selected: selected.value?.projectId ?? (launchOpen.value ? projectId.value : undefined),
}))
function rememberProject(id: string) {
  const prior = typeof projectVisits.value === 'object' && projectVisits.value !== null ? projectVisits.value : {}
  const entries = Object.entries(prior).filter(([key, at]) => key !== id && typeof at === 'number' && Number.isFinite(at)).toSorted((a, b) => Number(a[1]) - Number(b[1])).slice(-63)
  projectVisits.value = Object.fromEntries([...entries, [id, Date.now()]])
}
const selectedProjectName = computed(() => displayProjects.value.find(project => project.id === projectId.value)?.name ?? 'Projects')
const navigationVisible = computed(() => !narrow.value || projectsOpen.value || !selected.value)
const selectedProjectUnavailable = computed(() => Boolean(projectId.value) && !projects.value.some(project => project.id === projectId.value))
const providers = computed(() => (['codex', 'claude', 'opencode'] as const).filter(value => capabilities.providers[value]))
const providerNames = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' }
const canStart = computed(() => !pending.value && capacity.value._tag === 'Available' && capacity.value.regular._tag !== 'Unavailable'
  && projects.value.some(project => project.id === projectId.value) && capabilities.providers[provider.value])
const canForce = computed(() => !pending.value && capacity.value._tag === 'Available' && capacity.value.manualPolicy._tag === 'Enabled')
const forceTotal = computed(() => capacity.value._tag === 'Available' ? capacity.value.reservedGiB + 8 : 8)
const capacityReason = computed(() => loading.value
  ? 'Connecting to the terminal host.'
  : capacity.value._tag === 'Unavailable'
    ? terminalFailureCopy.CapacityUnavailable
    : capacity.value.regular._tag === 'AtCapacity' ? 'Waiting to start' : '')

async function refresh() {
  if (refreshing.value)
    return
  refreshing.value = true
  const results = await Promise.allSettled([
    $fetch<unknown>('/api/terminal/projects', { timeout: 10000 }).then(parseTerminalProjects),
    $fetch<unknown>('/api/terminal/sessions', { timeout: 10000 }).then(parseTerminalSessions),
    $fetch<unknown>('/api/terminal/capacity', { timeout: 10000 }).then(parseTerminalCapacity),
  ])
  capacity.value = results[2].status === 'fulfilled' && results[2].value._tag === 'Ok'
    ? results[2].value.value
    : { _tag: 'Unavailable' }
  if (results[0].status === 'fulfilled' && results[0].value._tag === 'Ok' && results[1].status === 'fulfilled' && results[1].value._tag === 'Ok') {
    projects.value = results[0].value.value
    sessions.value = results[1].value.value
    storedLayout.value = reconcileTerminalLayout(layout.value, displayProjects.value, sessions.value)
    if (loading.value)
      selectFromRoute()
    if (!capabilities.providers[provider.value])
      provider.value = providers.value[0] ?? 'codex'
    failure.value = ''
  }
  else {
    failure.value = 'Could not load projects or sessions. Reload.'
  }
  loading.value = false
  refreshing.value = false
}

async function select(session: TerminalSession) {
  rememberProject(session.projectId)
  projectsOpen.value = false
  launchOpen.value = false
  diffOpen.value = false
  const current = Object.hasOwn(layout.value.projects, session.projectId) ? layout.value.projects[session.projectId]! : emptyTerminalProjectLayout()
  storedLayout.value = { ...layout.value, projectId: session.projectId, projects: { ...layout.value.projects, [session.projectId]: updateTerminalProjectLayout(current, { _tag: 'Open', sessionId: session.id }) } }
  await navigateTo({ path: '/sessions', query: { terminal: session.id } }, { replace: true })
}

async function selectProject(id: string) {
  rememberProject(id)
  projectId.value = id
  launchOpen.value = true
  diffOpen.value = false
  await navigateTo({ path: '/sessions', query: selectedId.value ? { terminal: selectedId.value } : {} }, { replace: true })
}

async function closeTab(id: string) {
  storedLayout.value = { ...layout.value, projects: { ...layout.value.projects, [projectId.value]: updateTerminalProjectLayout(projectLayout.value, { _tag: 'Close', sessionId: id }) } }
  if (!selectedId.value)
    diffOpen.value = false
  await navigateTo({ path: '/sessions', query: selectedId.value ? { terminal: selectedId.value } : {} }, { replace: true })
}

function split() {
  storedLayout.value = { ...layout.value, projects: { ...layout.value.projects, [projectId.value]: updateTerminalProjectLayout(projectLayout.value, { _tag: projectLayout.value.view._tag === 'Split' ? 'Unsplit' : 'Split' }) } }
}

async function tabKey(event: KeyboardEvent, index: number) {
  const key = event.key
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key))
    return
  event.preventDefault()
  const tabs = tabSessions.value
  const next = tabs[key === 'Home' ? 0 : key === 'End' ? tabs.length - 1 : (index + (key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
  if (!next)
    return
  await select(next)
  await nextTick()
  tabList.value?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(next.id)}"]`)?.focus()
}

function focusPane(session: TerminalSession) {
  if (selectedId.value !== session.id)
    void select(session)
}

function selectFromRoute() {
  const id = typeof route.query.terminal === 'string' ? route.query.terminal : undefined
  const session = sessions.value.find(value => value.id === id)
  if (session && session.id !== selectedId.value)
    void select(session)
}
// Inventory refresh must not replace a selection while its route navigation is still pending.
watch(() => route.query.terminal, selectFromRoute, { immediate: true })

async function launch(mode: 'Regular' | 'Force' = 'Regular') {
  if (!canStart.value)
    return
  pending.value = true
  failure.value = ''
  const previous = launchIntent.value
  const launchProject = projectId.value
  const originalPrompt = initialPrompt.value
  const prompt = initialPrompt.value.trim() || undefined
  const intent = terminalLaunchIntent(previous, { projectId: projectId.value, provider: provider.value, ...(prompt ? { initialPrompt: prompt } : {}) }, crypto.randomUUID(), mode)
  launchIntent.value = intent
  await $fetch<unknown>('/api/terminal/sessions', { method: 'POST', body: intent, timeout: 15000 }).then(parseTerminalSessionResult).then(async (result) => {
    if (result._tag === 'Err') {
      if (!['DeliveryUnknown', 'OwnershipUnknown', 'LaunchConflict'].includes(result.reason))
        launchIntent.value = undefined
      failure.value = terminalFailureCopy[result.reason]
      return
    }
    launchIntent.value = undefined
    if (initialDrafts.value[launchProject] === originalPrompt)
      initialDrafts.value[launchProject] = ''
    forceConfirmation.value = undefined
    sessions.value = [...sessions.value.filter(session => session.id !== result.value.id), result.value]
    if (projectId.value === launchProject)
      await select(result.value)
  }).catch(() => {
    failure.value = 'Could not start the Agent session. Retry.'
  }).finally(() => { pending.value = false })
}

async function forceWaiting(id: string) {
  if (!canForce.value)
    return
  pending.value = true
  failure.value = ''
  const requestId = forceAttempts.get(id) ?? crypto.randomUUID()
  forceAttempts.set(id, requestId)
  await $fetch<unknown>(`/api/terminal/sessions/${encodeURIComponent(id)}/force`, { method: 'POST', body: { requestId }, timeout: 15000 }).then(parseTerminalSessionResult).then((result) => {
    if (result._tag === 'Err') {
      failure.value = terminalFailureCopy[result.reason]
      if (!['OwnershipUnknown', 'DeliveryUnknown'].includes(result.reason))
        forceAttempts.delete(id)
    }
    else {
      forceAttempts.delete(id)
      sessions.value = sessions.value.map(session => session.id === result.value.id ? result.value : session)
      if (result.value.state === 'Queued')
        failure.value = terminalFailureCopy.CapacityRefused
      forceConfirmation.value = undefined
    }
  }).catch(() => {
    failure.value = 'Could not start the Agent session. Retry.'
  }).finally(() => { pending.value = false })
}

async function confirmForce() {
  const confirmation = forceConfirmation.value
  if (confirmation?._tag === 'New')
    await launch('Force')
  else if (confirmation?._tag === 'Waiting')
    await forceWaiting(confirmation.id)
}

async function stop(id = selected.value?.id) {
  if (!id || pending.value)
    return
  pending.value = true
  failure.value = ''
  await $fetch<unknown>(`/api/terminal/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST', timeout: 15000 }).then(parseTerminalSessionResult).then((result) => {
    if (result._tag === 'Err') {
      failure.value = terminalFailureCopy[result.reason]
    }
    else {
      sessions.value = sessions.value.map(session => session.id === result.value.id ? result.value : session)
      stopConfirm.value = false
    }
  }).catch(() => {
    failure.value = 'Could not stop the Agent session. Retry.'
  }).finally(() => { pending.value = false })
}

function requestStop(session: TerminalSession) {
  stopTarget.value = session.id
  stopConfirm.value = true
}

watch(projectsOpen, async (open) => {
  if (open) {
    await nextTick()
    if (!window.matchMedia('(pointer: coarse)').matches)
      projectFilter.value?.inputRef?.focus({ preventScroll: true })
  }
})
useEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape' && projectsOpen.value) {
    projectsOpen.value = false
    event.preventDefault()
  }
})

onMounted(refresh)
const polling = useIntervalFn(refresh, 5000, { immediateCallback: false })
watch(visibility, (value) => {
  if (value === 'visible') {
    polling.resume()
    void refresh()
  }
  else {
    polling.pause()
  }
}, { immediate: true })
</script>

<template>
  <div class="relative flex h-full min-h-0 flex-col lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:grid-rows-1">
    <aside v-show="navigationVisible" class="absolute inset-0 z-20 flex min-h-0 flex-col bg-default lg:static lg:border-r lg:border-default lg:bg-muted" aria-label="Projects">
      <div class="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-default px-3">
        <span class="text-sm font-semibold">Projects</span>
        <div class="flex items-center gap-1">
          <UButton v-if="capabilities.controller" to="/sessions?view=history" icon="i-octicon-history-16" aria-label="History" variant="ghost" class="min-h-11 min-w-11 justify-center" />
          <UButton v-if="selected" icon="i-octicon-x-16" aria-label="Back to session" variant="ghost" class="min-h-11 min-w-11 justify-center lg:hidden" @click="projectsOpen = false" />
        </div>
      </div>
      <div class="shrink-0 p-3">
        <UInput ref="projectFilter" v-model="filter" aria-label="Find a session" placeholder="Find a project or session" icon="i-octicon-search-16" class="w-full" :ui="{ base: 'min-h-11 text-base' }" />
      </div>
      <div v-if="!filter.trim()" class="flex min-h-11 shrink-0 items-center justify-between gap-2 px-3 text-sm">
        <span class="text-muted">{{ showAllProjects ? 'All projects' : 'Recent projects' }}</span>
        <UButton v-if="projectGroups.hidden || showAllProjects" color="neutral" variant="link" class="min-h-11" @click="showAllProjects = !showAllProjects">
          {{ showAllProjects ? 'Show recent' : 'Show all' }}<span v-if="!showAllProjects" class="text-muted">({{ projectGroups.hidden }})</span>
        </UButton>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2" aria-label="Session list">
        <p v-if="loading" role="status" class="p-3 text-sm text-muted">
          Connecting to the terminal host.
        </p>
        <p v-else-if="!projectGroups.groups.length" role="status" class="p-3 text-sm text-muted">
          {{ filter.trim() ? 'No projects or sessions match.' : 'No recent projects. Search or show all.' }}
        </p>
        <section v-for="group in projectGroups.groups" :key="group.id" :aria-labelledby="`project-group-${group.id}`" class="mb-4">
          <h3 :id="`project-group-${group.id}`" class="px-2 py-2 text-xs font-semibold text-muted">
            {{ group.label }}
          </h3>
          <div v-for="project in group.projects" :key="project.id" class="mb-3">
            <button class="flex min-h-11 w-full items-center gap-2 rounded px-2 text-left text-sm font-medium hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary" :class="projectId === project.id ? 'text-highlighted' : 'text-muted'" :aria-pressed="projectId === project.id" @click="selectProject(project.id)">
              <UIcon name="i-octicon-repo-16" class="size-4 shrink-0" aria-hidden="true" />
              <span class="min-w-0 break-words">{{ project.name }}</span>
            </button>
            <p v-if="!projects.some(value => value.id === project.id)" class="px-2 pb-1 text-sm text-muted">
              {{ terminalFailureCopy.ProjectUnavailable }}
            </p>
            <button v-for="session in projectSessions(project.id)" :key="session.id" class="flex min-h-14 w-full items-center gap-3 rounded py-2 pr-3 pl-4 text-left text-sm hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary" :class="selectedId === session.id ? 'bg-accented text-highlighted' : 'text-default'" :aria-current="selectedId === session.id ? 'page' : undefined" @click="select(session)">
              <span class="size-2 shrink-0 rounded-full" :class="session.state === 'Running' ? 'bg-success' : session.state === 'Interrupted' || session.state === 'Unknown' ? 'bg-warning' : 'bg-neutral-500'" aria-hidden="true" />
              <span class="min-w-0 flex-1">
                <span class="block">{{ sessionLabel(session) }}</span>
                <span class="block text-sm text-muted">{{ new Date(session.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) }}</span>
              </span>
              <span class="max-w-28 text-right text-sm text-muted">{{ sessionState(session) }}</span>
            </button>
          </div>
        </section>
      </div>
      <div class="max-h-[60%] shrink-0 overflow-y-auto border-t border-default bg-muted p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div v-if="failure" role="alert" class="mb-2 flex items-center gap-2 text-sm text-error">
          <p>{{ failure }}</p><UButton icon="i-octicon-sync-16" aria-label="Reload" color="neutral" variant="ghost" @click="refresh" />
        </div>
        <div v-if="launchOpen" class="space-y-3">
          <div class="flex min-h-11 items-center justify-between gap-2 text-sm font-medium">
            <span class="min-w-0 break-words">{{ selectedProjectName }}</span>
            <UButton icon="i-octicon-x-16" aria-label="Close new session" variant="ghost" class="min-h-11 min-w-11 justify-center" @click="launchOpen = false" />
          </div>
          <UTextarea v-model="initialPrompt" aria-label="Initial prompt" placeholder="Initial prompt (optional)" :maxlength="8192" :rows="3" class="w-full" :ui="{ base: 'text-base' }" :disabled="pending" />
          <div class="flex gap-2">
            <select v-model="provider" aria-label="Agent provider" class="min-h-11 min-w-0 flex-1 rounded border border-default bg-default px-2 text-base focus-visible:outline-2 focus-visible:outline-primary">
              <option v-for="value in providers" :key="value" :value="value">
                {{ providerNames[value] }}
              </option>
            </select>
            <UButton icon="i-octicon-plus-16" class="min-h-11" :disabled="!canStart" :loading="pending" @click="launch()">
              New session
            </UButton>
          </div>
          <p v-if="capacityReason" role="status" class="text-sm text-muted">
            {{ capacityReason }}
          </p>
          <details v-if="capacity._tag === 'Available'" class="text-sm text-muted">
            <summary class="flex min-h-11 cursor-pointer items-center focus-visible:outline-2 focus-visible:outline-primary">
              Host memory
            </summary>
            <div class="space-y-2 pb-2">
              <p>{{ capacity.reservedGiB }} / {{ capacity.memoryGiB }} GiB · {{ capacity.agentSlotsUsed }} / {{ capacity.agentSlots }} Agent sessions</p>
              <UButton v-if="canForce && canStart" color="warning" variant="outline" class="min-h-11" @click="forceConfirmation = { _tag: 'New' }">
                Force new session
              </UButton>
            </div>
          </details>
        </div>
        <UButton v-else icon="i-octicon-plus-16" class="min-h-11 w-full justify-center" :disabled="loading || !projectId" @click="launchOpen = true">
          New session
        </UButton>
      </div>
    </aside>
    <section class="flex min-h-0 min-w-0 flex-1 flex-col" :inert="narrow && navigationVisible" :aria-hidden="narrow && navigationVisible">
      <p v-if="selectedProjectUnavailable" role="status" class="shrink-0 border-b border-default px-3 py-2 text-xs text-muted">
        {{ terminalFailureCopy.ProjectUnavailable }}
      </p>
      <div class="flex h-11 min-w-0 shrink-0 items-center border-b border-default bg-muted lg:h-10">
        <button aria-label="Projects" :aria-expanded="projectsOpen" class="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-3 text-left focus-visible:outline-2 focus-visible:outline-primary lg:hidden" @click="projectsOpen = true">
          <UIcon name="i-octicon-chevron-left-16" class="size-4 shrink-0" aria-hidden="true" />
          <span class="min-w-0"><span class="block truncate text-sm font-medium">{{ selectedProjectName }}</span><span v-if="selected" class="block text-sm text-muted">{{ sessionLabel(selected) }}</span></span>
        </button>
        <div ref="tabList" role="tablist" aria-label="Agent sessions" class="hidden min-w-0 flex-1 self-stretch overflow-x-auto lg:flex">
          <div v-for="(session, index) in tabSessions" :key="session.id" role="presentation" class="flex shrink-0 items-center border-r border-default" :class="!diffOpen && selectedId === session.id ? 'border-t-2 border-t-accented bg-default text-highlighted' : 'text-muted'">
            <button :id="`terminal-tab-${session.id}`" role="tab" :data-tab="session.id" :aria-selected="!diffOpen && selectedId === session.id" :aria-controls="visibleSessions.some(value => value.id === session.id) ? `terminal-pane-${session.id}` : undefined" :tabindex="!diffOpen && selectedId === session.id ? 0 : -1" class="flex h-full max-w-48 min-w-0 items-center gap-2 px-3 text-xs focus-visible:outline-2 focus-visible:outline-primary" @click="select(session)" @keydown="tabKey($event, index)">
              <UIcon name="i-octicon-terminal-16" class="size-3 shrink-0" />
              <span class="truncate">{{ sessionLabel(session) }}</span>
            </button>
            <button aria-label="Close tab" class="flex size-11 shrink-0 items-center justify-center text-dimmed hover:bg-elevated hover:text-highlighted focus-visible:outline-2 focus-visible:outline-primary lg:size-8" @click="closeTab(session.id)">
              <UIcon name="i-octicon-x-16" class="size-3" />
            </button>
          </div>
          <div v-if="diffOpen" role="presentation" class="flex shrink-0 items-center border-r border-t-2 border-default border-t-accented bg-default text-highlighted">
            <button role="tab" aria-selected="true" aria-controls="terminal-diff" class="flex h-full items-center gap-2 px-3 text-xs focus-visible:outline-2 focus-visible:outline-primary" @keydown.left.prevent="selected && select(selected)">
              <UIcon name="i-octicon-diff-16" class="size-3" />Diff
            </button>
            <button aria-label="Close diff" class="flex size-8 items-center justify-center hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary" @click="diffOpen = false">
              <UIcon name="i-octicon-x-16" class="size-3" />
            </button>
          </div>
          <span v-if="tabSessions.length === 0" class="flex items-center px-3 text-xs text-muted">Sessions</span>
        </div>
        <div class="flex shrink-0 items-center gap-1 px-1">
          <UButton v-if="canForce && selected?.state === 'Unknown'" color="warning" variant="ghost" size="xs" @click="forceConfirmation = { _tag: 'Waiting', id: selected.id }">
            Force start
          </UButton>
          <UButton v-if="selected && !narrow" icon="i-octicon-columns-16" :aria-label="projectLayout.view._tag === 'Split' ? 'Show one terminal' : 'Split terminal'" variant="ghost" size="xs" :disabled="tabSessions.length < 2" :aria-pressed="projectLayout.view._tag === 'Split'" @click="split" />
          <UButton v-if="selected" :icon="diffOpen ? 'i-octicon-terminal-16' : 'i-octicon-diff-16'" :aria-label="diffOpen ? 'Show terminal' : 'Show diff'" variant="ghost" size="xs" :aria-pressed="diffOpen" class="min-h-11 min-w-11 justify-center" @click="diffOpen = !diffOpen" />
          <UButton v-if="selected && !narrow && ['Starting', 'Running', 'Unknown'].includes(selected.state)" variant="ghost" size="xs" color="error" :loading="pending" @click="requestStop(selected)">
            Stop Agent
          </UButton>
          <UDropdownMenu v-if="selected && narrow" :items="[[{ label: 'Close tab', icon: 'i-octicon-x-16', onSelect: () => closeTab(selected!.id) }], ...(['Starting', 'Running', 'Unknown'].includes(selected.state) ? [[{ label: 'Stop Agent', icon: 'i-octicon-stop-16', color: 'error' as const, onSelect: () => requestStop(selected!) }]] : [])]">
            <UButton icon="i-octicon-kebab-horizontal-16" aria-label="Session actions" color="neutral" variant="ghost" class="min-h-11 min-w-11 justify-center" />
          </UDropdownMenu>
        </div>
      </div>
      <p v-if="failure" role="alert" class="shrink-0 border-b border-error/30 px-3 py-2 text-xs text-error">
        {{ failure }}
      </p>
      <div v-if="selected" ref="terminalArea" class="relative min-h-0 flex-1">
        <!-- Visibility preserves renderer dimensions and attachments while Diff is open. -->
        <div class="absolute inset-0 grid min-h-0 min-w-0" :class="[visibleSessions.length === 2 ? 'grid-cols-2' : 'grid-cols-1', diffOpen ? 'invisible' : '']" :inert="diffOpen">
          <div v-for="session in visibleSessions" :id="`terminal-pane-${session.id}`" :key="session.id + session.generation" role="tabpanel" :aria-labelledby="`terminal-tab-${session.id}`" class="flex min-h-0 min-w-0 flex-col border-default not-first:border-l" :class="visibleSessions.length === 2 && selectedId === session.id ? 'ring-1 ring-primary/40 ring-inset' : ''" @focusin="focusPane(session)" @pointerdown="focusPane(session)">
            <div v-if="visibleSessions.length === 2" class="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-default bg-muted px-2 text-[10px] text-muted">
              <span class="truncate">{{ providerNames[session.provider] }}</span><span class="truncate">{{ capabilities.hostLabel }}</span>
            </div>
            <div v-if="session.state === 'Queued' || session.state === 'Cancelled'" role="status" class="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-sm text-muted">
              <p>{{ session.state === 'Queued' ? 'Waiting to start' : 'Session cancelled.' }}</p>
              <div v-if="session.state === 'Queued'" class="flex gap-2">
                <UButton color="neutral" variant="outline" size="sm" :loading="pending" @click="stop(session.id)">
                  Cancel session
                </UButton>
                <UButton v-if="canForce" color="warning" variant="outline" size="sm" @click="forceConfirmation = { _tag: 'Waiting', id: session.id }">
                  Force start
                </UButton>
              </div>
            </div>
            <TerminalView v-else v-model:submission="memory(session).submission" v-model:reading="memory(session).reading" :session="session" :cached-screen="screens[screenKey(session)]" :draft="drafts.forSession(session).value" class="min-h-0 min-w-0 flex-1" @screen="cacheScreen(session, $event)" @update:draft="drafts.forSession(session).value = $event" />
          </div>
        </div>
        <TerminalDiff v-if="diffOpen" id="terminal-diff" :key="selected.id" role="tabpanel" aria-label="Diff" :target="{ _tag: 'Session', sessionId: selected.id }" class="relative z-10 h-full min-h-0 min-w-0 bg-default" @close="diffOpen = false" />
      </div>
      <div v-else role="status" class="flex flex-1 items-center justify-center p-6 text-sm text-muted">
        {{ loading ? 'Connecting to the terminal host.' : 'Choose a project to start.' }}
      </div>
    </section>
    <ConfirmModal v-model:open="stopConfirm" title="Stop Agent?" consequence="This stops the Agent. The session and its work remain available." confirm-label="Stop Agent" :pending="pending" :error="failure || null" @confirm="stop(stopTarget)" />
    <UModal :open="Boolean(forceConfirmation)" title="Force start" :description="`This session reserves 8 GiB of host memory. Total reserved: ${forceTotal} GiB. Force can still be refused.`" @update:open="!$event && (forceConfirmation = undefined)">
      <template #footer>
        <UButton color="neutral" variant="ghost" :disabled="pending" @click="forceConfirmation = undefined">
          Cancel
        </UButton>
        <UButton color="warning" :loading="pending" :disabled="!canForce" @click="confirmForce">
          {{ forceConfirmation?._tag === 'New' ? 'Force new session' : 'Force start' }}
        </UButton>
      </template>
    </UModal>
  </div>
</template>
