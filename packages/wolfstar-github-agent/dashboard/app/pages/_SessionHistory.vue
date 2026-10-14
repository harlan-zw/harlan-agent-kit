<script setup lang="ts">
import type { DesktopSession, SessionHost } from '../../../src/session-protocol.ts'
import type { AgentLogSelection } from '../utils/agent-logs.ts'
import type { SessionViewSnapshot } from '../utils/session.ts'
import { useEventListener, useIntervalFn, useResizeObserver, useSessionStorage } from '@vueuse/core'
import { agentLogs, selectAgentLog } from '../utils/agent-logs.ts'
import { createSessionDisclosures } from '../utils/session-disclosure.ts'
import {
  sessionBottomTarget,
  sessionCanFollow,
  sessionDistanceFromBottom,
  sessionFollowOnScroll,
} from '../utils/session-scroll.ts'
import {
  sessionFailureMessage,
  sessionHostLabels,
  sessionHostProjects,
  sessionHostStatus,
  sessionRunning,
  sessionTimeline,
} from '../utils/session.ts'
import SessionActivity from './_SessionActivity.vue'
import SessionMessage from './_SessionMessage.vue'

const route = useRoute()
const terminalHost = useTerminalHost()
const { readOnly, controllerPath } = terminalHost
const { snapshot } = useDashboard()
const selectedLogId = computed(() => (typeof route.query.task === 'string' ? route.query.task : undefined))
const logSelection = shallowRef<AgentLogSelection>({ _tag: 'Unselected' })
const logs = computed(() =>
  agentLogs(snapshot.value).filter(
    (log) =>
      (log.host === host.value || log.host === null) &&
      `${log.repository} ${log.title}`.toLowerCase().includes(filter.value.toLowerCase()),
  ),
)
watch(
  [snapshot, selectedLogId],
  () => {
    logSelection.value = selectAgentLog(snapshot.value, selectedLogId.value, logSelection.value)
  },
  { immediate: true },
)
const data = ref<SessionViewSnapshot>()
const loading = ref(true)
const failure = ref<{ message: string }>()
const loadFailure = ref('')
const pending = ref(false)
const host = useSessionStorage<SessionHost>('agent-session-history-host', 'desktop', {
  initOnMounted: true,
  serializer: { read: (value) => (value === 'hogwild' ? 'hogwild' : 'desktop'), write: (value) => value },
})
const filter = ref('')
const sidebarOpen = ref(false)
const conversation = useTemplateRef<HTMLElement>('conversation')
const content = useTemplateRef<HTMLElement>('content')
const following = ref(true)
const atBottom = ref(true)
const selected = computed(() => data.value?.sessions.find((session) => session.id === route.query.session))
const projects = computed(() =>
  sessionHostProjects(data.value, host.value).filter((project) =>
    project.name.toLowerCase().includes(filter.value.toLowerCase()),
  ),
)
const sessions = computed(() => data.value?.sessions.filter((session) => session.host === host.value) ?? [])
const running = computed(() => sessionRunning(selected.value))
const timeline = computed(() => sessionTimeline(selected.value))
const disclosures = createSessionDisclosures(reactive(new Map<string, boolean>()))
let lastWriteTop = -1
let previousTop = 0
let refreshPending = false

function scrollLatest(): void {
  const element = conversation.value
  if (!element) return
  following.value = true
  element.scrollTop = sessionBottomTarget(element)
  lastWriteTop = element.scrollTop
  previousTop = element.scrollTop
  atBottom.value = true
}

function followLatest(): void {
  const element = conversation.value
  if (!element) return
  if (sessionCanFollow({ geometry: element, lastWriteTop, following: following.value })) scrollLatest()
  atBottom.value = sessionDistanceFromBottom(element) <= 32
}

function onScroll(): void {
  const element = conversation.value
  if (!element) return
  following.value = sessionFollowOnScroll({ geometry: element, lastWriteTop, previousTop, following: following.value })
  previousTop = element.scrollTop
  atBottom.value = sessionDistanceFromBottom(element) <= 32
}

watch(
  () => selected.value?.id,
  async () => {
    if (selected.value) host.value = selected.value.host
    following.value = true
    lastWriteTop = -1
    disclosures.reset()
    await nextTick()
    scrollLatest()
  },
)
watch(
  () => timeline.value.length,
  async () => {
    await nextTick()
    followLatest()
  },
)
useResizeObserver(content, followLatest)
useEventListener(conversation, 'scroll', onScroll, { passive: true })
useEventListener(
  conversation,
  'wheel',
  (event: WheelEvent) => {
    if (event.deltaY < 0) following.value = false
  },
  { passive: true },
)

async function refresh(): Promise<void> {
  if (refreshPending) return
  refreshPending = true
  if (terminalHost.state.value._tag === 'Checking') await terminalHost.start()
  await $fetch<SessionViewSnapshot>(controllerPath('/api/sessions'))
    .then((value) => {
      data.value = value
      loadFailure.value = ''
    })
    .catch((error: unknown) => {
      loadFailure.value = sessionFailureMessage(error, 'Could not load sessions. Retry.')
    })
  loading.value = false
  refreshPending = false
}

async function selectSession(id?: string): Promise<void> {
  sidebarOpen.value = false
  failure.value = undefined
  await navigateTo({ path: '/sessions', query: id ? { view: 'history', session: id } : { view: 'history' } })
}

async function selectHost(value: SessionHost): Promise<void> {
  host.value = value
  filter.value = ''
  await selectSession()
}

async function watchLogs(id: string): Promise<void> {
  sidebarOpen.value = false
  await navigateTo({ path: '/sessions', query: { view: 'history', task: id } })
}

watch(
  () => logSelection.value,
  (selection) => {
    if (selection._tag === 'Live' && selection.log.host !== null) host.value = selection.log.host
  },
  { immediate: true },
)

function remember(session: DesktopSession): void {
  if (!data.value) return
  data.value.sessions = [session, ...data.value.sessions.filter((value) => value.id !== session.id)]
}

async function stop(): Promise<void> {
  if (readOnly.value) {
    failure.value = { message: 'Read-only Service connection.' }
    return
  }
  if (!selected.value || pending.value) return
  const sessionId = selected.value.id
  pending.value = true
  failure.value = undefined
  await $fetch<DesktopSession>(`/api/sessions/${sessionId}/stop`, { method: 'POST' })
    .then(remember)
    .catch((error: unknown) => {
      if (selected.value?.id === sessionId)
        failure.value = { message: sessionFailureMessage(error, 'Could not stop the Agent. Retry.') }
    })
  pending.value = false
}

onMounted(refresh)
useIntervalFn(refresh, 2500)
useEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape') sidebarOpen.value = false
})
usePageTitle('History')
</script>

<template>
  <div class="session-workspace grid min-h-0 md:grid-cols-[16rem_minmax(0,1fr)]">
    <aside
      id="session-projects"
      :class="sidebarOpen ? 'flex' : 'hidden md:flex'"
      class="min-h-0 flex-col border-b border-default bg-muted md:border-b-0 md:border-r"
      aria-label="Projects and sessions"
    >
      <div class="space-y-3 p-4">
        <UButton
          class="md:hidden"
          color="neutral"
          variant="ghost"
          icon="i-octicon-x-16"
          aria-label="Close projects"
          @click="sidebarOpen = false"
        >
          Close projects
        </UButton>
        <div>
          <p class="mb-2 text-sm font-medium text-muted">Run on</p>
          <div
            class="grid grid-cols-2 gap-1 rounded-lg border border-default bg-default p-1"
            role="group"
            aria-label="Run on"
          >
            <button
              v-for="candidate in ['desktop', 'hogwild'] as const"
              :key="candidate"
              type="button"
              class="flex min-h-11 flex-col items-start rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
              :class="host === candidate ? 'bg-accented text-highlighted' : 'text-muted'"
              :aria-pressed="host === candidate"
              @click="selectHost(candidate)"
            >
              <span class="font-medium">{{ sessionHostLabels[candidate] }}</span>
              <span class="flex items-center gap-1 text-sm"
                ><span
                  class="size-1.5 rounded-full"
                  :class="sessionHostStatus(data, candidate) === 'Connected' ? 'bg-success' : 'bg-warning'"
                />{{ sessionHostStatus(data, candidate) }}</span
              >
            </button>
          </div>
        </div>
        <UInput
          v-model="filter"
          class="w-full"
          icon="i-octicon-search-16"
          placeholder="Find a project"
          aria-label="Find a project"
        />
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <div class="mb-4">
          <h2 class="px-2 py-2 text-sm font-medium text-muted">Watch logs</h2>
          <button
            v-for="log in logs"
            :key="log.id"
            type="button"
            class="flex min-h-11 w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-accented"
            :class="selectedLogId === log.id ? 'bg-accented text-highlighted' : 'text-muted'"
            :aria-current="selectedLogId === log.id ? 'page' : undefined"
            @click="watchLogs(log.id)"
          >
            <UIcon name="i-octicon-terminal-16" class="mt-0.5 size-4 shrink-0" />
            <span class="min-w-0"
              ><span class="block truncate text-sm">{{ log.title }}</span
              ><span class="block truncate text-xs text-muted">{{ log.kind }} / {{ log.phase }}</span></span
            >
          </button>
          <p v-if="!logs.length" class="px-2 text-sm text-muted">No running Agents on this host.</p>
        </div>
        <p v-if="loading" class="px-2 py-4 text-muted" role="status">Loading projects…</p>
        <p v-else-if="!projects.length" class="px-2 py-4 text-muted">
          {{ filter ? 'No matching projects.' : `No projects available on ${sessionHostLabels[host]}.` }}
        </p>
        <div v-for="project in projects" :key="project.id" class="mb-2">
          <div class="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left font-medium">
            <UIcon name="i-octicon-file-directory-16" class="size-4 shrink-0 text-muted" />
            <span class="min-w-0 flex-1 truncate">{{ project.name }}</span
            ><span class="text-sm text-muted">{{ project.kind }}</span>
          </div>
          <button
            v-for="session in sessions.filter((value) => value.project.id === project.id)"
            :key="session.id"
            class="flex min-h-11 w-full items-center gap-2 rounded-md py-2 pl-8 pr-2 text-left transition-colors hover:bg-accented"
            :class="selected?.id === session.id ? 'bg-accented text-highlighted' : 'text-muted'"
            @click="selectSession(session.id)"
          >
            <span
              class="size-1.5 shrink-0 rounded-full"
              :class="
                sessionRunning(session)
                  ? 'bg-success'
                  : session.status === 'failed' || session.status === 'interrupted'
                    ? 'bg-warning'
                    : 'bg-current opacity-40'
              "
            /><span class="truncate">{{ session.title }}</span>
          </button>
        </div>
      </div>
    </aside>

    <AgentLogs
      v-if="selectedLogId"
      :selection="logSelection"
      :sidebar-open="sidebarOpen"
      @projects="sidebarOpen = !sidebarOpen"
    />
    <section v-else class="relative flex min-h-0 min-w-0 flex-col bg-default" aria-label="Agent conversation">
      <header class="flex min-h-16 shrink-0 items-center gap-3 border-b border-default px-4 lg:px-8">
        <UButton
          class="md:hidden"
          color="neutral"
          variant="ghost"
          icon="i-octicon-sidebar-expand-16"
          aria-label="Toggle projects"
          :aria-expanded="sidebarOpen"
          aria-controls="session-projects"
          @click="sidebarOpen = !sidebarOpen"
        />
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-base font-medium">
            {{ selected?.title ?? 'History' }}
          </h1>
          <p v-if="selected" class="truncate text-sm text-muted">
            {{ selected.project.name }} <span class="mx-1">/</span> {{ sessionHostLabels[selected.host] }}
            <span class="mx-1">/</span> {{ selected.status }}
          </p>
        </div>
        <UButton
          v-if="!readOnly && (running || selected?.status === 'interrupted')"
          color="neutral"
          variant="outline"
          :loading="pending"
          :disabled="selected?.status === 'stopping'"
          icon="i-octicon-square-fill-16"
          @click="stop"
        >
          {{ selected?.status === 'stopping' ? 'Stopping' : 'Stop Agent' }}
        </UButton>
      </header>

      <div
        ref="conversation"
        class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 lg:px-8"
        tabindex="0"
        aria-label="Conversation messages"
      >
        <div ref="content" class="mx-auto max-w-3xl py-5">
          <div v-if="failure || loadFailure" role="alert" class="mb-5 rounded-md border border-error/30 bg-error/5 p-4">
            <p class="break-words">
              {{ failure?.message || loadFailure }}
            </p>
            <UButton v-if="failure" class="mt-2" color="neutral" variant="outline" :disabled="pending" @click="stop">
              Retry stop
            </UButton>
            <UButton v-else class="mt-2" color="neutral" variant="outline" @click="refresh"> Retry loading </UButton>
          </div>
          <div v-if="!selected && !loading" class="flex min-h-56 flex-col justify-center">
            <h2 class="text-xl font-medium">History</h2>
            <p v-if="!loadFailure" class="mt-2 text-base text-muted">Choose an Agent session from History.</p>
          </div>
          <p v-if="route.query.session && !selected && !loading && !loadFailure" class="text-muted" role="status">
            This session is unavailable. Choose another session.
          </p>
          <template v-for="entry in timeline" :key="entry.id">
            <SessionMessage v-if="entry.kind === 'message'" :role="entry.role" :text="entry.text" />
            <SessionActivity
              v-else
              :tools="entry.tools"
              :expanded="
                disclosures.get(
                  entry.id,
                  entry.tools.some((tool) => tool.status === 'running'),
                )
              "
              @expanded="disclosures.set(entry.id, $event)"
            />
          </template>
          <p v-if="running" class="my-5 flex items-center gap-2 text-sm text-muted" role="status">
            <span class="live-dot size-1.5 rounded-full bg-success" />{{
              selected?.status === 'queued'
                ? 'Starting Agent…'
                : selected?.status === 'stopping'
                  ? 'Stopping Agent…'
                  : 'Agent is working…'
            }}
          </p>
          <p
            v-if="selected?.status === 'interrupted'"
            class="my-5 rounded-md border border-warning/30 bg-warning/5 p-3 text-sm"
            role="status"
          >
            {{ sessionHostLabels[selected.host] }} disconnected. Stop the Agent before continuing.
          </p>
        </div>
      </div>

      <!-- Adapted from KiroCrew ChatScrollChrome.tsx. Apache-2.0; see THIRD-PARTY-NOTICES.md. -->
      <div v-if="!atBottom" class="pointer-events-none absolute bottom-4 inset-x-0 flex justify-center">
        <UButton
          class="pointer-events-auto"
          color="neutral"
          variant="outline"
          icon="i-octicon-arrow-down-16"
          @click="scrollLatest"
        >
          Latest message
        </UButton>
      </div>
    </section>
  </div>
</template>

<style scoped>
.session-workspace {
  height: 100%;
  min-height: 0;
}
@media (max-width: 767px) {
  .session-workspace {
    position: relative;
  }
  .session-workspace > aside {
    position: absolute;
    inset: 0 3rem 0 0;
    z-index: 20;
    border-right: 1px solid var(--ui-border);
  }
}
</style>
