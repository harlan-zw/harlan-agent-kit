<script setup lang="ts">
import type { AgentProviderName } from '../../../src/agent-provider.ts'
import type { DesktopSession, SessionHost, StartSessionRequest } from '../../../src/session-protocol.ts'
import type { CodexReasoningEffort } from '../../../src/types.ts'
import type { SessionViewSnapshot } from '../utils/session.ts'
import { useEventListener, useIntervalFn, useResizeObserver, useSessionStorage } from '@vueuse/core'
import { createSessionDisclosures } from '../utils/session-disclosure.ts'
import { createSessionImeLatch } from '../utils/session-ime.ts'
import { sessionBottomTarget, sessionCanFollow, sessionDistanceFromBottom, sessionFollowOnScroll } from '../utils/session-scroll.ts'
import { parseSessionComposerStorage, sessionAcceptsMessage, sessionFailureMessage, sessionHostLabels, sessionHostProjects, sessionHostStatus, sessionProjectAvailable, sessionRunning, sessionTimeline } from '../utils/session.ts'
import SessionActivity from './_SessionActivity.vue'
import SessionMessage from './_SessionMessage.vue'

const route = useRoute()
const { snapshot } = useDashboard()
const data = ref<SessionViewSnapshot>()
const loading = ref(true)
const failure = ref<{ action: 'send' | 'stop', message: string }>()
const loadFailure = ref('')
const pending = ref(false)
const composerSelection = useSessionStorage('agent-session-composer', { host: 'desktop' as SessionHost, projectId: '' }, {
  serializer: { read: parseSessionComposerStorage, write: JSON.stringify },
})
const host = computed({
  get: () => composerSelection.value.host,
  set: (value: SessionHost) => { composerSelection.value = { ...composerSelection.value, host: value } },
})
const projectId = computed({
  get: () => composerSelection.value.projectId,
  set: (value: string) => { composerSelection.value = { ...composerSelection.value, projectId: value } },
})
const provider = ref<AgentProviderName>('codex')
const model = ref('')
const reasoningEffort = ref<CodexReasoningEffort>('high')
const filter = ref('')
const sidebarOpen = ref(false)
const conversation = useTemplateRef<HTMLElement>('conversation')
const content = useTemplateRef<HTMLElement>('content')
const following = ref(true)
const atBottom = ref(true)
const drafts = useSessionStorage<Record<string, string>>('agent-session-drafts', {})
const selected = computed(() => data.value?.sessions.find(session => session.id === route.query.session))
const activeHost = computed(() => selected.value?.host ?? host.value)
const draftKey = computed(() => selected.value?.id ?? `new:${host.value}:${projectId.value}`)
const prompt = computed({
  get: () => drafts.value[draftKey.value] ?? '',
  set: (value) => {
    drafts.value = { ...drafts.value, [draftKey.value]: value }
  },
})
const online = computed(() => loadFailure.value === '' && data.value?.hosts[activeHost.value].connected === true && data.value.hosts[activeHost.value].current)
const projects = computed(() => sessionHostProjects(data.value, host.value).filter(project => project.name.toLowerCase().includes(filter.value.toLowerCase())))
const sessions = computed(() => data.value?.sessions.filter(session => session.host === host.value) ?? [])
const models = computed(() => [...snapshot.value.agentModels[provider.value]])
const running = computed(() => sessionRunning(selected.value))
const timeline = computed(() => sessionTimeline(selected.value))
const canSend = computed(() => !loading.value && online.value && !pending.value && prompt.value.trim().length > 0 && (selected.value !== undefined ? sessionAcceptsMessage(selected.value) : sessionProjectAvailable(data.value, host.value, projectId.value) && model.value !== ''))
const unavailable = computed(() => sessionHostStatus(data.value, activeHost.value))
const disclosures = createSessionDisclosures(reactive(new Map<string, boolean>()))
const ime = createSessionImeLatch()
let lastWriteTop = -1
let previousTop = 0
let lastRequest: { signature: string, id: string } | undefined
let refreshPending = false

watch(models, (values) => {
  if (!values.includes(model.value as never))
    model.value = values[0] ?? ''
}, { immediate: true })

function scrollLatest(): void {
  const element = conversation.value
  if (!element)
    return
  following.value = true
  element.scrollTop = sessionBottomTarget(element)
  lastWriteTop = element.scrollTop
  previousTop = element.scrollTop
  atBottom.value = true
}

function followLatest(): void {
  const element = conversation.value
  if (!element)
    return
  if (sessionCanFollow({ geometry: element, lastWriteTop, following: following.value }))
    scrollLatest()
  atBottom.value = sessionDistanceFromBottom(element) <= 32
}

function onScroll(): void {
  const element = conversation.value
  if (!element)
    return
  following.value = sessionFollowOnScroll({ geometry: element, lastWriteTop, previousTop, following: following.value })
  previousTop = element.scrollTop
  atBottom.value = sessionDistanceFromBottom(element) <= 32
}

watch(() => selected.value?.id, async () => {
  if (selected.value)
    host.value = selected.value.host
  following.value = true
  lastWriteTop = -1
  disclosures.reset()
  await nextTick()
  scrollLatest()
})
watch(() => timeline.value.length, async () => {
  await nextTick()
  followLatest()
})
useResizeObserver(content, followLatest)
useEventListener(conversation, 'scroll', onScroll, { passive: true })
useEventListener(conversation, 'wheel', (event: WheelEvent) => {
  if (event.deltaY < 0)
    following.value = false
}, { passive: true })

async function refresh(): Promise<void> {
  if (refreshPending)
    return
  refreshPending = true
  await $fetch<SessionViewSnapshot>('/api/sessions').then((value) => {
    data.value = value
    loadFailure.value = ''
  }).catch((error: unknown) => {
    loadFailure.value = sessionFailureMessage(error, 'Could not load sessions. Retry.')
  })
  loading.value = false
  refreshPending = false
}

async function selectSession(id?: string, project?: string): Promise<void> {
  projectId.value = project ?? ''
  sidebarOpen.value = false
  failure.value = undefined
  await navigateTo({ path: '/sessions', query: id ? { session: id } : {} })
}

async function selectHost(value: SessionHost): Promise<void> {
  host.value = value
  projectId.value = ''
  filter.value = ''
  await selectSession()
}

function remember(session: DesktopSession): void {
  if (!data.value)
    return
  data.value.sessions = [session, ...data.value.sessions.filter(value => value.id !== session.id)]
}

async function send(): Promise<void> {
  if (!canSend.value)
    return
  pending.value = true
  failure.value = undefined
  const text = prompt.value
  const key = draftKey.value
  const sessionId = selected.value?.id
  const signature = JSON.stringify([sessionId, host.value, projectId.value, provider.value, model.value, reasoningEffort.value, text])
  if (lastRequest?.signature !== signature)
    lastRequest = { signature, id: crypto.randomUUID() }
  const requestId = lastRequest.id
  const body: StartSessionRequest = { host: host.value, projectId: projectId.value, provider: provider.value, model: model.value, reasoningEffort: reasoningEffort.value, prompt: text, requestId }
  await $fetch<DesktopSession>(sessionId ? `/api/sessions/${sessionId}/messages` : '/api/sessions', {
    method: 'POST',
    body: sessionId ? { prompt: text, requestId } : body,
  }).then(async (session) => {
    if (drafts.value[key] === text)
      drafts.value = { ...drafts.value, [key]: '' }
    lastRequest = undefined
    remember(session)
    if (draftKey.value === key || selected.value?.id === session.id) {
      await selectSession(session.id)
      await nextTick()
      scrollLatest()
    }
  }).catch((error: unknown) => {
    failure.value = { action: 'send', message: sessionFailureMessage(error, 'Could not send the prompt. Retry.') }
  })
  pending.value = false
}

async function stop(): Promise<void> {
  if (!selected.value || pending.value)
    return
  pending.value = true
  failure.value = undefined
  await $fetch<DesktopSession>(`/api/sessions/${selected.value.id}/stop`, { method: 'POST' }).then(remember).catch((error: unknown) => {
    failure.value = { action: 'stop', message: sessionFailureMessage(error, 'Could not stop the Agent. Retry.') }
  })
  pending.value = false
}

function composerKey(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || !ime.claim(event))
    return
  event.preventDefault()
  void send()
}

onMounted(refresh)
useIntervalFn(refresh, 2500)
onScopeDispose(ime.reset)
useEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape')
    sidebarOpen.value = false
})
usePageTitle('Sessions')
</script>

<template>
  <div class="session-workspace grid min-h-0 md:grid-cols-[16rem_minmax(0,1fr)]">
    <aside id="session-projects" :class="sidebarOpen ? 'flex' : 'hidden md:flex'" class="min-h-0 flex-col border-b border-default bg-muted md:border-b-0 md:border-r" aria-label="Projects and sessions">
      <div class="space-y-3 p-4">
        <UButton class="md:hidden" color="neutral" variant="ghost" icon="i-octicon-x-16" aria-label="Close projects" @click="sidebarOpen = false">
          Close projects
        </UButton>
        <UButton block icon="i-octicon-plus-16" color="neutral" variant="outline" @click="selectSession()">
          New session
        </UButton>
        <div>
          <p class="mb-2 text-sm font-medium text-muted">
            Run on
          </p>
          <div class="grid grid-cols-2 gap-1 rounded-lg border border-default bg-default p-1" role="group" aria-label="Run on">
            <button v-for="candidate in (['desktop', 'hogwild'] as const)" :key="candidate" type="button" class="flex min-h-11 flex-col items-start rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted" :class="host === candidate ? 'bg-accented text-highlighted' : 'text-muted'" :aria-pressed="host === candidate" @click="selectHost(candidate)">
              <span class="font-medium">{{ sessionHostLabels[candidate] }}</span>
              <span class="flex items-center gap-1 text-sm"><span class="size-1.5 rounded-full" :class="sessionHostStatus(data, candidate) === 'Connected' ? 'bg-success' : 'bg-warning'" />{{ sessionHostStatus(data, candidate) }}</span>
            </button>
          </div>
        </div>
        <UInput v-model="filter" class="w-full" icon="i-octicon-search-16" placeholder="Find a project" aria-label="Find a project" />
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <p v-if="loading" class="px-2 py-4 text-muted" role="status">
          Loading projects…
        </p>
        <p v-else-if="!projects.length" class="px-2 py-4 text-muted">
          {{ filter ? 'No matching projects.' : `No projects available on ${sessionHostLabels[host]}.` }}
        </p>
        <div v-for="project in projects" :key="project.id" class="mb-2">
          <button class="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left font-medium transition-colors hover:bg-accented" :class="projectId === project.id ? 'bg-accented' : ''" @click="selectSession(undefined, project.id)">
            <UIcon name="i-octicon-file-directory-16" class="size-4 shrink-0 text-muted" />
            <span class="min-w-0 flex-1 truncate">{{ project.name }}</span><span class="text-sm text-muted">{{ project.kind }}</span>
          </button>
          <button v-for="session in sessions.filter(value => value.project.id === project.id)" :key="session.id" class="flex min-h-11 w-full items-center gap-2 rounded-md py-2 pl-8 pr-2 text-left transition-colors hover:bg-accented" :class="selected?.id === session.id ? 'bg-accented text-highlighted' : 'text-muted'" @click="selectSession(session.id)">
            <span class="size-1.5 shrink-0 rounded-full" :class="sessionRunning(session) ? 'bg-success' : session.status === 'failed' || session.status === 'interrupted' ? 'bg-warning' : 'bg-current opacity-40'" /><span class="truncate">{{ session.title }}</span>
          </button>
        </div>
      </div>
    </aside>

    <section class="relative flex min-h-0 min-w-0 flex-col bg-default" aria-label="Agent conversation">
      <header class="flex min-h-16 shrink-0 items-center gap-3 border-b border-default px-4 lg:px-8">
        <UButton class="md:hidden" color="neutral" variant="ghost" icon="i-octicon-sidebar-expand-16" aria-label="Toggle projects" :aria-expanded="sidebarOpen" aria-controls="session-projects" @click="sidebarOpen = !sidebarOpen" />
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-base font-medium">
            {{ selected?.title ?? 'New session' }}
          </h1>
          <p v-if="selected" class="truncate text-sm text-muted">
            {{ selected.project.name }} <span class="mx-1">/</span> {{ sessionHostLabels[selected.host] }} <span class="mx-1">/</span> {{ selected.status }}
          </p>
        </div>
        <UButton v-if="running || selected?.status === 'interrupted'" color="neutral" variant="outline" :loading="pending" :disabled="selected?.status === 'stopping'" icon="i-octicon-square-fill-16" @click="stop">
          {{ selected?.status === 'stopping' ? 'Stopping' : 'Stop Agent' }}
        </UButton>
      </header>

      <div ref="conversation" class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 lg:px-8" tabindex="0" aria-label="Conversation messages">
        <div ref="content" class="mx-auto max-w-3xl py-5">
          <div v-if="failure || loadFailure" role="alert" class="mb-5 rounded-md border border-error/30 bg-error/5 p-4">
            <p class="break-words">
              {{ failure?.message || loadFailure }}
            </p>
            <UButton v-if="failure" class="mt-2" color="neutral" variant="outline" :disabled="pending || (failure.action === 'send' && !canSend)" @click="failure.action === 'send' ? send() : stop()">
              {{ failure.action === 'send' ? 'Retry message' : 'Retry stop' }}
            </UButton>
            <UButton v-else class="mt-2" color="neutral" variant="outline" @click="refresh">
              Retry loading
            </UButton>
          </div>
          <div v-if="!selected && !loading" class="flex min-h-56 flex-col justify-center">
            <h2 class="text-xl font-medium">
              What do you want to work on?
            </h2>
            <p v-if="!loadFailure" class="mt-2 text-base text-muted">
              {{ online ? `Choose a project on ${sessionHostLabels[activeHost]}.` : `${sessionHostLabels[activeHost]} is ${unavailable.toLowerCase()}.` }}
            </p>
          </div>
          <p v-if="route.query.session && !selected && !loading && !loadFailure" class="text-muted" role="status">
            This session is unavailable. Choose another session.
          </p>
          <template v-for="entry in timeline" :key="entry.id">
            <SessionMessage v-if="entry.kind === 'message'" :role="entry.role" :text="entry.text" />
            <SessionActivity v-else :tools="entry.tools" :expanded="disclosures.get(entry.id, entry.tools.some(tool => tool.status === 'running'))" @expanded="disclosures.set(entry.id, $event)" />
          </template>
          <p v-if="running" class="my-5 flex items-center gap-2 text-sm text-muted" role="status">
            <span class="live-dot size-1.5 rounded-full bg-success" />{{ selected?.status === 'queued' ? 'Starting Agent…' : selected?.status === 'stopping' ? 'Stopping Agent…' : 'Agent is working…' }}
          </p>
          <p v-if="selected?.status === 'interrupted'" class="my-5 rounded-md border border-warning/30 bg-warning/5 p-3 text-sm" role="status">
            {{ sessionHostLabels[selected.host] }} disconnected. Stop the Agent before continuing.
          </p>
        </div>
      </div>

      <form class="relative shrink-0 border-t border-transparent px-4 pb-4 pt-2 lg:px-8 lg:pb-6" @submit.prevent="send">
        <!-- Adapted from KiroCrew ChatScrollChrome.tsx. Apache-2.0; see THIRD-PARTY-NOTICES.md. -->
        <div v-if="!atBottom" class="pointer-events-none absolute -top-12 inset-x-0 flex justify-center">
          <UButton class="pointer-events-auto" color="neutral" variant="outline" icon="i-octicon-arrow-down-16" @click="scrollLatest">
            Latest message
          </UButton>
        </div>
        <div class="mx-auto max-w-3xl rounded-xl border border-accented bg-elevated p-3 transition-colors focus-within:border-inverted">
          <div v-if="!selected" class="mb-2 flex flex-wrap items-center gap-2">
            <USelect v-model="host" :items="[{ label: `Desktop (${sessionHostStatus(data, 'desktop')})`, value: 'desktop' }, { label: `Hogwild (${sessionHostStatus(data, 'hogwild')})`, value: 'hogwild' }]" aria-label="Run on" class="min-h-11 w-full sm:w-52" @update:model-value="selectHost" />
            <USelect v-model="projectId" :items="projects.map(project => ({ label: `${project.name} (${project.kind})`, value: project.id }))" placeholder="Choose a project" aria-label="Project" class="min-h-11 w-full sm:min-w-48 sm:flex-1" />
          </div>
          <UTextarea v-model="prompt" aria-label="Message to Agent" aria-description="Enter sends. Shift and Enter add a new line." placeholder="Ask the Agent to work on this project." variant="none" size="lg" :rows="2" autoresize :maxrows="8" :disabled="pending" class="w-full" :ui="{ base: 'resize-none' }" @keydown="composerKey" @compositionstart="ime.start" @compositionend="ime.end($event.data)" @blur="ime.reset" />
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <template v-if="!selected">
              <USelect v-model="provider" :items="[{ label: 'Codex', value: 'codex' }, { label: 'OpenCode', value: 'opencode' }]" aria-label="Agent provider" class="min-h-11 w-28" />
              <USelect v-model="model" :items="models" aria-label="Agent model" placeholder="Model" class="order-last min-h-11 min-w-0 basis-full sm:order-none sm:max-w-56 sm:flex-1 sm:basis-auto" />
              <USelect v-if="provider === 'codex'" v-model="reasoningEffort" :items="['low', 'medium', 'high', 'xhigh']" aria-label="Reasoning effort" class="min-h-11 w-24" />
            </template>
            <span v-else class="min-w-0 flex-1 break-words text-sm text-muted">{{ selected.provider }} <span class="mx-1">/</span> {{ selected.model }}</span>
            <UButton type="submit" icon="i-octicon-arrow-up-16" class="ml-auto min-h-11 min-w-11 justify-center" :disabled="!canSend" :loading="pending" aria-label="Send message" />
          </div>
        </div>
        <p class="mx-auto mt-2 flex max-w-3xl items-center gap-2 text-sm text-muted">
          <span class="size-1.5 shrink-0 rounded-full" :class="online ? 'bg-success' : 'bg-warning'" /><span class="shrink-0">{{ sessionHostLabels[activeHost] }}</span>
          <span v-if="!online" class="truncate">{{ unavailable }}</span>
          <span v-else-if="selected?.workspacePath" class="truncate font-mono" :title="selected.workspacePath">{{ selected.workspacePath }}</span>
        </p>
      </form>
    </section>
  </div>
</template>

<style scoped>
.session-workspace { height: calc(100dvh - 3rem); }
@media (max-width: 767px) {
  .session-workspace { position: relative; }
  .session-workspace > aside { position: absolute; inset: 0 3rem 0 0; z-index: 20; border-right: 1px solid var(--ui-border); }
}
</style>
