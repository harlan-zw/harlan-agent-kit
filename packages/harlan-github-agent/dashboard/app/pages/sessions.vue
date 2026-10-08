<script setup lang="ts">
import type { AgentProviderName } from '../../../src/agent-provider.ts'
import type { DesktopSession, SessionProject, StartSessionRequest } from '../../../src/session-protocol.ts'
import type { CodexReasoningEffort } from '../../../src/types.ts'
import { useEventListener, useIntervalFn, useScroll } from '@vueuse/core'
import { sessionAcceptsMessage, sessionActivity, sessionFailureMessage, sessionRunning, sessionTranscript } from '../utils/session.ts'

const route = useRoute()
const { snapshot } = useDashboard()
const data = ref<{ desktop: { connected: boolean, current: boolean }, projects: SessionProject[], sessions: DesktopSession[] }>()
const loading = ref(true)
const failure = ref<{ action: 'send' | 'stop', message: string }>()
const loadFailure = ref('')
const pending = ref(false)
const prompt = ref('')
const projectId = ref('')
const provider = ref<AgentProviderName>('codex')
const model = ref('')
const reasoningEffort = ref<CodexReasoningEffort>('high')
const filter = ref('')
const sidebarOpen = ref(false)
const conversation = useTemplateRef<HTMLElement>('conversation')
const { arrivedState } = useScroll(conversation)
let lastRequest: { signature: string, id: string } | undefined
const selected = computed(() => data.value?.sessions.find(session => session.id === route.query.session))
const online = computed(() => loadFailure.value === '' && data.value?.desktop.connected === true && data.value.desktop.current)
const projects = computed(() => data.value?.projects.filter(project => project.name.toLowerCase().includes(filter.value.toLowerCase())) ?? [])
const models = computed(() => [...snapshot.value.agentModels[provider.value]])
const running = computed(() => sessionRunning(selected.value))
const transcript = computed(() => sessionTranscript(selected.value))
const activity = computed(() => sessionActivity(selected.value))
const canSend = computed(() => online.value && !pending.value && prompt.value.trim().length > 0 && (selected.value !== undefined ? sessionAcceptsMessage(selected.value) : projectId.value !== '' && model.value !== ''))

watch(models, (values) => {
  if (!values.includes(model.value as never))
    model.value = values[0] ?? ''
}, { immediate: true })

watch(() => transcript.value.length, async () => {
  const follow = arrivedState.bottom
  await nextTick()
  if (follow && conversation.value)
    conversation.value.scrollTop = conversation.value.scrollHeight
})
watch(() => route.query.session, async () => {
  await nextTick()
  if (conversation.value)
    conversation.value.scrollTop = conversation.value.scrollHeight
})

async function refresh(): Promise<void> {
  await $fetch<typeof data.value>('/api/sessions').then((value) => {
    data.value = value
    loadFailure.value = ''
  }).catch((error: unknown) => {
    loadFailure.value = sessionFailureMessage(error, 'Could not load sessions. Retry.')
  })
  loading.value = false
}

async function selectSession(id?: string, project?: string): Promise<void> {
  projectId.value = project ?? ''
  sidebarOpen.value = false
  await navigateTo({ path: '/sessions', query: id ? { session: id } : {} })
}

async function send(): Promise<void> {
  if (!canSend.value)
    return
  pending.value = true
  failure.value = undefined
  const signature = JSON.stringify([selected.value?.id, projectId.value, provider.value, model.value, reasoningEffort.value, prompt.value])
  if (lastRequest?.signature !== signature)
    lastRequest = { signature, id: crypto.randomUUID() }
  const requestId = lastRequest.id
  const body: StartSessionRequest = { projectId: projectId.value, provider: provider.value, model: model.value, reasoningEffort: reasoningEffort.value, prompt: prompt.value, requestId }
  await $fetch<DesktopSession>(selected.value ? `/api/sessions/${selected.value.id}/messages` : '/api/sessions', {
    method: 'POST',
    body: selected.value ? { prompt: prompt.value, requestId } : body,
  }).then(async (session) => {
    prompt.value = ''
    lastRequest = undefined
    await refresh()
    await selectSession(session.id)
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
  await $fetch(`/api/sessions/${selected.value.id}/stop`, { method: 'POST' }).then(refresh).catch((error: unknown) => {
    failure.value = { action: 'stop', message: sessionFailureMessage(error, 'Could not stop the Agent. Retry.') }
  })
  pending.value = false
}

function composerKey(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    void send()
  }
}

onMounted(refresh)
useIntervalFn(refresh, 2500)
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
        <UInput v-model="filter" class="w-full" icon="i-octicon-search-16" placeholder="Find a project" aria-label="Find a project" />
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <p v-if="loading" class="px-2 py-4 text-muted" role="status">
          Loading projects…
        </p>
        <p v-else-if="!projects.length" class="px-2 py-4 text-muted">
          {{ filter ? 'No matching projects.' : 'No projects available.' }}
        </p>
        <div v-for="project in projects" :key="project.id" class="mb-3">
          <button class="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left font-medium transition-colors hover:bg-accented" :class="projectId === project.id ? 'bg-accented' : ''" @click="selectSession(undefined, project.id)">
            <UIcon name="i-octicon-file-directory-16" class="size-4 shrink-0 text-muted" />
            <span class="min-w-0 flex-1 truncate">{{ project.name }}</span>
            <span class="text-sm text-muted">{{ project.kind }}</span>
          </button>
          <button v-for="session in data?.sessions.filter(value => value.project.id === project.id)" :key="session.id" class="flex min-h-11 w-full items-center gap-2 rounded-md py-2 pl-8 pr-2 text-left transition-colors hover:bg-accented" :class="selected?.id === session.id ? 'bg-accented text-highlighted' : 'text-muted'" @click="selectSession(session.id)">
            <span class="size-1.5 shrink-0 rounded-full" :class="sessionRunning(session) ? 'bg-success' : 'bg-current opacity-40'" />
            <span class="truncate">{{ session.title }}</span>
          </button>
        </div>
      </div>
      <div class="flex min-h-12 items-center gap-2 border-t border-default px-4 text-sm">
        <UIcon name="i-octicon-device-desktop-16" class="size-4" />
        <span class="size-1.5 rounded-full" :class="online ? 'bg-success' : 'bg-warning'" />
        {{ online ? 'Desktop connected' : data?.desktop.connected ? 'Desktop update required' : 'Desktop offline' }}
      </div>
    </aside>

    <section class="flex min-h-0 min-w-0 flex-col bg-default" aria-label="Agent conversation">
      <header class="flex min-h-14 items-center gap-3 border-b border-default px-4 lg:px-8">
        <UButton class="md:hidden" color="neutral" variant="ghost" icon="i-octicon-sidebar-expand-16" aria-label="Toggle projects" :aria-expanded="sidebarOpen" aria-controls="session-projects" @click="sidebarOpen = !sidebarOpen" />
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-base font-medium">
            {{ selected?.title ?? 'New session' }}
          </h1>
          <p v-if="selected" class="truncate text-sm text-muted">
            {{ selected.project.name }} <span class="mx-1">/</span> {{ selected.status }}
          </p>
        </div>
        <UButton v-if="running || selected?.status === 'interrupted'" color="neutral" variant="outline" :loading="pending" :disabled="selected?.status === 'stopping'" icon="i-octicon-square-fill-16" @click="stop">
          {{ selected?.status === 'stopping' ? 'Stopping' : 'Stop Agent' }}
        </UButton>
      </header>

      <div ref="conversation" class="min-h-0 flex-1 overflow-y-auto px-4 py-6 lg:px-8">
        <div class="mx-auto max-w-3xl">
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
              {{ online ? 'Choose a project to start.' : 'Connect your desktop to Tailscale to start.' }}
            </p>
          </div>
          <div v-for="message in transcript" :key="message.id" class="mb-8">
            <p class="mb-2 text-sm font-medium text-muted">
              {{ message.role }}
            </p>
            <p class="whitespace-pre-wrap break-words text-base leading-7">
              {{ message.text }}
            </p>
          </div>
          <p v-if="running" class="mb-5 flex items-center gap-2 text-muted" role="status">
            <span class="live-dot size-1.5 rounded-full bg-success" />{{ selected?.status === 'queued' ? 'Starting Agent…' : selected?.status === 'stopping' ? 'Stopping Agent…' : 'Agent is working…' }}
          </p>
          <p v-if="selected?.status === 'interrupted'" class="mb-5 text-muted" role="status">
            The desktop disconnected. Stop the Agent before continuing.
          </p>
          <details v-if="activity.length" class="mb-6 rounded-md border border-default">
            <summary class="min-h-11 cursor-pointer px-4 py-3 font-medium">
              Activity <span class="ml-1 font-mono text-muted">{{ activity.length }}</span>
            </summary>
            <div class="space-y-2 border-t border-default p-3">
              <details v-for="entry in activity" :key="entry.id" class="rounded-md bg-muted">
                <summary class="min-h-11 cursor-pointer break-words px-3 py-2 font-mono text-sm">
                  {{ entry.label }}
                </summary>
                <pre class="max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-sm">{{ entry.detail }}</pre>
              </details>
            </div>
          </details>
        </div>
      </div>

      <form class="px-4 pb-4 pt-2 lg:px-8 lg:pb-6" @submit.prevent="send">
        <div class="mx-auto max-w-3xl rounded-xl border border-accented bg-elevated p-3">
          <USelect v-if="!selected" v-model="projectId" :items="data?.projects.map(project => ({ label: `${project.name} (${project.kind})`, value: project.id })) ?? []" placeholder="Choose a project" aria-label="Project" class="mb-3 w-full sm:w-72" />
          <UTextarea v-model="prompt" aria-label="Message to Agent" placeholder="Ask the Agent to work on this project." variant="none" size="lg" :rows="3" autoresize :maxrows="8" class="w-full" :ui="{ base: 'resize-none' }" @keydown="composerKey" />
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <template v-if="!selected">
              <USelect v-model="provider" :items="[{ label: 'Codex', value: 'codex' }, { label: 'OpenCode', value: 'opencode' }]" aria-label="Agent provider" class="w-28" />
              <USelect v-model="model" :items="models" aria-label="Agent model" placeholder="Model" class="order-last min-w-0 basis-full sm:order-none sm:max-w-56 sm:flex-1 sm:basis-auto" />
              <USelect v-if="provider === 'codex'" v-model="reasoningEffort" :items="['low', 'medium', 'high', 'xhigh']" aria-label="Reasoning effort" class="w-24" />
            </template>
            <span v-else class="text-sm text-muted">{{ selected.provider }} <span class="mx-1">/</span> {{ selected.model }}</span>
            <UButton type="submit" icon="i-octicon-arrow-up-16" class="ml-auto min-h-11 min-w-11 justify-center" :disabled="!canSend" :loading="pending" aria-label="Send message" />
          </div>
        </div>
        <p v-if="selected?.workspacePath" class="mx-auto mt-2 max-w-3xl truncate font-mono text-sm text-muted" :title="selected.workspacePath">
          {{ selected.workspacePath }}
        </p>
      </form>
    </section>
  </div>
</template>

<style scoped>
.session-workspace { height: calc(100dvh - 3rem); }
@media (max-width: 767px) { .session-workspace { position: relative; } .session-workspace > aside { position: absolute; inset: 0 3rem 0 0; z-index: 20; border-right: 1px solid var(--ui-border); } }
</style>
