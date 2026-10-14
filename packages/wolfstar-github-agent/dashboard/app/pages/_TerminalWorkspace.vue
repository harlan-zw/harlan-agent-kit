<script setup lang="ts">
import type {
  TerminalCapabilities,
  TerminalProject,
  TerminalProvider,
  TerminalSession,
} from '../../../src/terminal-protocol.ts'
import type { TerminalCapacity } from '../utils/terminal-capacity.ts'
import { useDocumentVisibility, useIntervalFn, useMediaQuery, useStorage } from '@vueuse/core'
import { parseTerminalCapacity } from '../utils/terminal-capacity.ts'
import { terminalFailureCopy } from '../utils/terminal-copy.ts'
import {
  activeTerminalSession,
  emptyTerminalLayout,
  emptyTerminalProjectLayout,
  parseTerminalLayout,
  reconcileTerminalLayout,
  terminalDisplayProjects,
  updateTerminalProjectLayout,
} from '../utils/terminal-layout.ts'
import { parseTerminalProjects, parseTerminalSessionResult, parseTerminalSessions } from '../utils/terminal-protocol.ts'
import TerminalView from './_TerminalView.vue'

const { capabilities } = defineProps<{ capabilities: TerminalCapabilities }>()

// Diff rendering stays outside the terminal bundle until the user opens it.
const TerminalDiff = defineAsyncComponent(() => import('../components/_TerminalDiff.vue'))

const route = useRoute()
const projects = shallowRef<TerminalProject[]>([])
const sessions = shallowRef<TerminalSession[]>([])
const displayProjects = computed(() => terminalDisplayProjects(projects.value, sessions.value))
const capacity = shallowRef<TerminalCapacity>({ _tag: 'Unavailable' })
const filter = ref('')
const storedLayout = useStorage<unknown>(
  `agent-terminal-layout:${capabilities.hostId}`,
  emptyTerminalLayout(),
  undefined,
  { initOnMounted: true },
)
const layout = computed(() => {
  const parsed = parseTerminalLayout(storedLayout.value)
  return parsed._tag === 'Ok' ? parsed.value : emptyTerminalLayout()
})
const projectId = computed({
  get: () => layout.value.projectId,
  set: (value) => {
    storedLayout.value = { ...layout.value, projectId: value }
  },
})
const projectLayout = computed(() =>
  Object.hasOwn(layout.value.projects, projectId.value)
    ? layout.value.projects[projectId.value]!
    : emptyTerminalProjectLayout(),
)
const narrow = useMediaQuery('(max-width: 767px)')
const tabList = useTemplateRef<HTMLElement>('tabList')
const terminalArea = useTemplateRef<HTMLElement>('terminalArea')
const provider = ref<TerminalProvider>('codex')
const failure = ref('')
const pending = ref(false)
const loading = ref(true)
const refreshing = ref(false)
const visibility = useDocumentVisibility()
const diffOpen = ref(false)
const launchIntent = shallowRef<{ requestId: string; projectId: string; provider: TerminalProvider }>()
const selectedId = computed(() => activeTerminalSession(projectLayout.value))
const selected = computed(() => sessions.value.find((session) => session.id === selectedId.value))
const tabSessions = computed(() =>
  projectLayout.value.tabs
    .map((id) => sessions.value.find((session) => session.id === id))
    .filter((session): session is TerminalSession => session !== undefined),
)
const visibleSessions = computed(() => {
  const view = projectLayout.value.view
  const ids =
    view._tag === 'Empty' ? [] : view._tag === 'Single' || narrow.value ? [selectedId.value] : [view.left, view.right]
  return ids
    .map((id) => sessions.value.find((session) => session.id === id))
    .filter((session): session is TerminalSession => session !== undefined)
})
const visibleProjects = computed(() =>
  displayProjects.value.filter((project) => project.name.toLowerCase().includes(filter.value.toLowerCase())),
)
const selectedProjectUnavailable = computed(
  () => Boolean(projectId.value) && !projects.value.some((project) => project.id === projectId.value),
)
const providers = computed(() =>
  (['codex', 'claude', 'opencode'] as const).filter((value) => capabilities.providers[value]),
)
const providerNames = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' }
const canStart = computed(
  () =>
    !pending.value &&
    capacity.value._tag === 'Available' &&
    capacity.value.interactiveFree > 0 &&
    projects.value.some((project) => project.id === projectId.value) &&
    capabilities.providers[provider.value],
)
const capacityReason = computed(() =>
  loading.value
    ? 'Connecting to the terminal host.'
    : capacity.value._tag === 'Unavailable'
      ? terminalFailureCopy.CapacityUnavailable
      : capacity.value.interactiveFree === 0
        ? terminalFailureCopy.CapacityRefused
        : '',
)

async function refresh() {
  if (refreshing.value) return
  refreshing.value = true
  const results = await Promise.allSettled([
    $fetch<unknown>('/api/terminal/projects').then(parseTerminalProjects),
    $fetch<unknown>('/api/terminal/sessions').then(parseTerminalSessions),
    $fetch<unknown>('/api/terminal/capacity').then(parseTerminalCapacity),
  ])
  capacity.value =
    results[2].status === 'fulfilled' && results[2].value._tag === 'Ok'
      ? results[2].value.value
      : { _tag: 'Unavailable' }
  if (
    results[0].status === 'fulfilled' &&
    results[0].value._tag === 'Ok' &&
    results[1].status === 'fulfilled' &&
    results[1].value._tag === 'Ok'
  ) {
    projects.value = results[0].value.value
    sessions.value = results[1].value.value
    storedLayout.value = reconcileTerminalLayout(layout.value, displayProjects.value, sessions.value)
    if (!capabilities.providers[provider.value]) provider.value = providers.value[0] ?? 'codex'
    failure.value = ''
  } else {
    failure.value = 'Could not load projects or sessions. Reload.'
  }
  loading.value = false
  refreshing.value = false
}

async function select(session: TerminalSession) {
  diffOpen.value = false
  const current = Object.hasOwn(layout.value.projects, session.projectId)
    ? layout.value.projects[session.projectId]!
    : emptyTerminalProjectLayout()
  storedLayout.value = {
    ...layout.value,
    projectId: session.projectId,
    projects: {
      ...layout.value.projects,
      [session.projectId]: updateTerminalProjectLayout(current, { _tag: 'Open', sessionId: session.id }),
    },
  }
  await navigateTo({ path: '/sessions', query: { terminal: session.id } }, { replace: true })
}

async function selectProject(id: string) {
  projectId.value = id
  diffOpen.value = false
  await navigateTo(
    { path: '/sessions', query: selectedId.value ? { terminal: selectedId.value } : {} },
    { replace: true },
  )
}

async function closeTab(id: string) {
  storedLayout.value = {
    ...layout.value,
    projects: {
      ...layout.value.projects,
      [projectId.value]: updateTerminalProjectLayout(projectLayout.value, { _tag: 'Close', sessionId: id }),
    },
  }
  if (!selectedId.value) diffOpen.value = false
  await navigateTo(
    { path: '/sessions', query: selectedId.value ? { terminal: selectedId.value } : {} },
    { replace: true },
  )
}

function split() {
  storedLayout.value = {
    ...layout.value,
    projects: {
      ...layout.value.projects,
      [projectId.value]: updateTerminalProjectLayout(projectLayout.value, {
        _tag: projectLayout.value.view._tag === 'Split' ? 'Unsplit' : 'Split',
      }),
    },
  }
}

async function tabKey(event: KeyboardEvent, index: number) {
  const key = event.key
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return
  event.preventDefault()
  const tabs = tabSessions.value
  const next =
    tabs[
      key === 'Home'
        ? 0
        : key === 'End'
          ? tabs.length - 1
          : (index + (key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    ]
  if (!next) return
  await select(next)
  await nextTick()
  tabList.value?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(next.id)}"]`)?.focus()
}

function focusPane(session: TerminalSession) {
  if (selectedId.value !== session.id) void select(session)
}

watch([() => route.query.terminal, sessions], () => {
  const id = typeof route.query.terminal === 'string' ? route.query.terminal : undefined
  const session = sessions.value.find((value) => value.id === id)
  if (session && session.id !== selectedId.value) void select(session)
})

async function launch() {
  if (!canStart.value) return
  pending.value = true
  failure.value = ''
  const previous = launchIntent.value
  const intent =
    previous?.projectId === projectId.value && previous.provider === provider.value
      ? previous
      : { requestId: crypto.randomUUID(), projectId: projectId.value, provider: provider.value }
  launchIntent.value = intent
  await $fetch<unknown>('/api/terminal/sessions', { method: 'POST', body: intent })
    .then(parseTerminalSessionResult)
    .then(async (result) => {
      if (result._tag === 'Err') {
        if (!['DeliveryUnknown', 'OwnershipUnknown', 'LaunchConflict'].includes(result.reason))
          launchIntent.value = undefined
        failure.value = terminalFailureCopy[result.reason]
        return
      }
      launchIntent.value = undefined
      sessions.value = [...sessions.value.filter((session) => session.id !== result.value.id), result.value]
      await select(result.value)
    })
    .catch(() => {
      failure.value = 'Could not start the Agent session. Retry.'
    })
    .finally(() => {
      pending.value = false
    })
}

async function stop() {
  if (!selected.value || pending.value) return
  pending.value = true
  await $fetch<unknown>(`/api/terminal/sessions/${encodeURIComponent(selected.value.id)}/stop`, { method: 'POST' })
    .then(parseTerminalSessionResult)
    .then((result) => {
      if (result._tag === 'Err') failure.value = terminalFailureCopy[result.reason]
      else sessions.value = sessions.value.map((session) => (session.id === result.value.id ? result.value : session))
    })
    .catch(() => {
      failure.value = 'Could not stop the Agent session. Retry.'
    })
    .finally(() => {
      pending.value = false
    })
}

onMounted(refresh)
const polling = useIntervalFn(refresh, 5000, { immediateCallback: false })
watch(
  visibility,
  (value) => {
    if (value === 'visible') {
      polling.resume()
      void refresh()
    } else {
      polling.pause()
    }
  },
  { immediate: true },
)
</script>

<template>
  <div
    class="grid h-full min-h-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[240px_minmax(0,1fr)] md:grid-rows-1"
  >
    <aside
      class="flex min-h-0 flex-col border-b border-default bg-muted md:border-r md:border-b-0"
      aria-label="Projects"
    >
      <div class="flex h-10 shrink-0 items-center justify-between border-b border-default px-3">
        <span class="text-xs font-semibold tracking-wide">Projects</span>
        <UButton
          v-if="capabilities.controller"
          to="/sessions?view=history"
          icon="i-octicon-history-16"
          aria-label="History"
          variant="ghost"
          size="xs"
        />
      </div>
      <div class="flex shrink-0 gap-2 p-2">
        <UInput
          v-model="filter"
          aria-label="Filter projects"
          placeholder="Filter projects"
          icon="i-octicon-search-16"
          class="w-full"
          size="sm"
        />
        <UButton v-if="failure" icon="i-octicon-sync-16" aria-label="Reload" variant="ghost" @click="refresh" />
      </div>
      <div class="max-h-40 overflow-auto md:max-h-none md:flex-1">
        <div v-for="project in visibleProjects" :key="project.id">
          <button
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-elevated"
            :class="projectId === project.id ? 'bg-elevated text-highlighted' : 'text-muted'"
            :aria-pressed="projectId === project.id"
            @click="selectProject(project.id)"
          >
            <UIcon name="i-octicon-repo-16" class="size-4 shrink-0" />
            <span class="truncate">{{ project.name }}</span>
          </button>
          <p v-if="!projects.some((value) => value.id === project.id)" class="px-3 pb-1 text-xs text-muted">
            {{ terminalFailureCopy.ProjectUnavailable }}
          </p>
          <button
            v-for="session in sessions.filter((value) => value.projectId === project.id)"
            :key="session.id"
            class="flex w-full items-center gap-2 py-1.5 pr-3 pl-8 text-left text-xs hover:bg-elevated"
            :class="selectedId === session.id ? 'bg-accented text-highlighted' : 'text-muted'"
            :aria-current="selectedId === session.id ? 'page' : undefined"
            @click="select(session)"
          >
            <span
              class="size-1.5 shrink-0 rounded-full"
              :class="session.state === 'Running' ? 'bg-success' : 'bg-neutral-500'"
            />
            <span class="flex-1 truncate">{{ providerNames[session.provider] }}</span>
            <span class="text-[10px]">{{ session.state }}</span>
          </button>
        </div>
      </div>
      <p v-if="capacityReason" role="status" class="shrink-0 border-t border-default px-3 py-2 text-xs text-muted">
        {{ capacityReason }}
      </p>
      <div class="flex shrink-0 gap-2 border-t border-default p-2">
        <select
          v-model="provider"
          aria-label="Agent provider"
          class="min-w-0 flex-1 rounded border border-default bg-default px-2 text-xs"
        >
          <option v-for="value in providers" :key="value" :value="value">
            {{ providerNames[value] }}
          </option>
        </select>
        <UButton icon="i-octicon-plus-16" size="sm" :disabled="!canStart" :loading="pending" @click="launch">
          New session
        </UButton>
      </div>
    </aside>
    <section class="flex min-h-0 min-w-0 flex-col">
      <p
        v-if="selectedProjectUnavailable"
        role="status"
        class="shrink-0 border-b border-default px-3 py-2 text-xs text-muted"
      >
        {{ terminalFailureCopy.ProjectUnavailable }}
      </p>
      <div class="flex h-10 min-w-0 shrink-0 items-center border-b border-default bg-muted">
        <div
          ref="tabList"
          role="tablist"
          aria-label="Agent sessions"
          class="flex min-w-0 flex-1 self-stretch overflow-x-auto"
        >
          <div
            v-for="(session, index) in tabSessions"
            :key="session.id"
            role="presentation"
            class="flex shrink-0 items-center border-r border-default"
            :class="
              !diffOpen && selectedId === session.id
                ? 'border-t-2 border-t-accented bg-default text-highlighted'
                : 'text-muted'
            "
          >
            <button
              :id="`terminal-tab-${session.id}`"
              role="tab"
              :data-tab="session.id"
              :aria-selected="!diffOpen && selectedId === session.id"
              :aria-controls="
                visibleSessions.some((value) => value.id === session.id) ? `terminal-pane-${session.id}` : undefined
              "
              :tabindex="!diffOpen && selectedId === session.id ? 0 : -1"
              class="flex h-full max-w-48 min-w-0 items-center gap-2 px-3 text-xs focus-visible:outline-2 focus-visible:outline-primary"
              @click="select(session)"
              @keydown="tabKey($event, index)"
            >
              <UIcon name="i-octicon-terminal-16" class="size-3 shrink-0" />
              <span class="truncate">{{ providerNames[session.provider] }} {{ index + 1 }}</span>
            </button>
            <button
              aria-label="Close tab"
              class="flex size-8 shrink-0 items-center justify-center text-dimmed hover:bg-elevated hover:text-highlighted focus-visible:outline-2 focus-visible:outline-primary"
              @click="closeTab(session.id)"
            >
              <UIcon name="i-octicon-x-16" class="size-3" />
            </button>
          </div>
          <div
            v-if="diffOpen"
            role="presentation"
            class="flex shrink-0 items-center border-r border-t-2 border-default border-t-accented bg-default text-highlighted"
          >
            <button
              role="tab"
              aria-selected="true"
              aria-controls="terminal-diff"
              class="flex h-full items-center gap-2 px-3 text-xs focus-visible:outline-2 focus-visible:outline-primary"
              @keydown.left.prevent="selected && select(selected)"
            >
              <UIcon name="i-octicon-diff-16" class="size-3" />Diff
            </button>
            <button
              aria-label="Close diff"
              class="flex size-8 items-center justify-center hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
              @click="diffOpen = false"
            >
              <UIcon name="i-octicon-x-16" class="size-3" />
            </button>
          </div>
          <span v-if="tabSessions.length === 0" class="flex items-center px-3 text-xs text-muted">Sessions</span>
        </div>
        <div class="flex shrink-0 items-center gap-1 px-1">
          <UButton
            v-if="selected && !narrow"
            icon="i-octicon-columns-16"
            :aria-label="projectLayout.view._tag === 'Split' ? 'Show one terminal' : 'Split terminal'"
            variant="ghost"
            size="xs"
            :disabled="tabSessions.length < 2"
            :aria-pressed="projectLayout.view._tag === 'Split'"
            @click="split"
          />
          <UButton
            v-if="selected"
            :icon="diffOpen ? 'i-octicon-terminal-16' : 'i-octicon-diff-16'"
            :aria-label="diffOpen ? 'Show terminal' : 'Show diff'"
            variant="ghost"
            size="xs"
            :aria-pressed="diffOpen"
            @click="diffOpen = !diffOpen"
          />
          <UButton
            v-if="selected && ['Starting', 'Running', 'Unknown'].includes(selected.state)"
            variant="ghost"
            size="xs"
            color="error"
            :loading="pending"
            @click="stop"
          >
            Stop Agent
          </UButton>
        </div>
      </div>
      <p v-if="failure" role="alert" class="shrink-0 border-b border-error/30 px-3 py-2 text-xs text-error">
        {{ failure }}
      </p>
      <div v-if="selected" ref="terminalArea" class="relative min-h-0 flex-1">
        <!-- Visibility preserves renderer dimensions and attachments while Diff is open. -->
        <div
          class="absolute inset-0 grid min-h-0 min-w-0"
          :class="[visibleSessions.length === 2 ? 'grid-cols-2' : 'grid-cols-1', diffOpen ? 'invisible' : '']"
          :inert="diffOpen"
        >
          <div
            v-for="session in visibleSessions"
            :id="`terminal-pane-${session.id}`"
            :key="session.id + session.generation"
            role="tabpanel"
            :aria-labelledby="`terminal-tab-${session.id}`"
            class="flex min-h-0 min-w-0 flex-col border-default not-first:border-l"
            :class="
              visibleSessions.length === 2 && selectedId === session.id ? 'ring-1 ring-primary/40 ring-inset' : ''
            "
            @focusin="focusPane(session)"
            @pointerdown="focusPane(session)"
          >
            <div
              v-if="visibleSessions.length === 2"
              class="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-default bg-muted px-2 text-[10px] text-muted"
            >
              <span class="truncate">{{ providerNames[session.provider] }}</span
              ><span class="truncate">{{ capabilities.hostLabel }}</span>
            </div>
            <TerminalView :session="session" class="min-h-0 min-w-0 flex-1" />
          </div>
        </div>
        <TerminalDiff
          v-if="diffOpen"
          id="terminal-diff"
          :key="selected.id"
          role="tabpanel"
          aria-label="Diff"
          :target="{ _tag: 'Session', sessionId: selected.id }"
          class="relative z-10 h-full min-h-0 min-w-0 bg-default"
          @close="diffOpen = false"
        />
      </div>
      <div v-else role="status" class="flex flex-1 items-center justify-center p-6 text-sm text-muted">
        {{ loading ? 'Connecting to the terminal host.' : 'Choose a project to start.' }}
      </div>
    </section>
  </div>
</template>
