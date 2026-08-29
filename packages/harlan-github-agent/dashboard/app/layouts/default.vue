<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { AgentProviderName } from '../../../src/agent-provider.ts'
import type { AgentModel, AgentSelection, CodexReasoningEffort, QueueEntry } from '../../../src/types.ts'
import { useLocalStorage } from '@vueuse/core'
import { AGENT_PROVIDER_NAMES } from '../../../src/agent-profile.ts'
import { agentProfileState, agentRoleLabels, decisionKey, incidentEntries, statusClass } from '../utils/dashboard.ts'

const {
  snapshot,
  loading,
  decisions,
  activeAgents,
  unhealthyRepositories,
  connectionLabel,
  liveStatus,
  isStale,
  loadError,
  controlError,
  controlPending,
  relativeTime,
  loadState,
  start,
  setAgentControl,
  requestRestart,
  setSelectionMode,
  switchAgent,
} = useDashboard()

const route = useRoute()
const colorMode = useColorMode()

const notificationPreference = useLocalStorage('harlan-agent-notifications', false)
const notificationsSupported = ref(false)
const notificationsOn = ref(false)
const notificationError = ref<string>()
const seenDecisions = ref(new Set<string>())
const decisionsSeeded = ref(false)

const incidents = computed(() => incidentEntries(snapshot.value.incidents))
/** Incidents the controller will not clear on its own. */
const blockingIncidents = computed(() => incidents.value.filter(incident => incident.recovery._tag !== 'Retrying').length)

const pages = computed(() => [
  { to: '/', label: 'Board', icon: 'i-lucide-columns-3', count: decisions.value.length, tone: 'warning' as const },
  { to: '/history', label: 'History', icon: 'i-lucide-history', count: 0, tone: 'warning' as const },
  { to: '/stats', label: 'Stats', icon: 'i-lucide-chart-no-axes-column', count: 0, tone: 'warning' as const },
  { to: '/watching', label: 'Watching', icon: 'i-lucide-radio', count: unhealthyRepositories.value, tone: 'error' as const },
  { to: '/flow', label: 'Flow', icon: 'i-lucide-git-branch', count: 0, tone: 'warning' as const },
])

/** Only says something when the engine is not in its default state. */
const agentControlLabel = computed(() => {
  if (snapshot.value.agentControl._tag === 'Running')
    return undefined
  return snapshot.value.agentControl.safeToRestart ? 'paused, safe to restart' : 'paused, finishing active work'
})

const restartActive = computed(() => snapshot.value.restartRequest?._tag === 'Requested'
  || snapshot.value.restartRequest?._tag === 'Restarting')

const restartLabel = computed(() => {
  if (snapshot.value.restartRequest?._tag === 'Requested')
    return 'restart requested, finishing active work'
  if (snapshot.value.restartRequest?._tag === 'Restarting')
    return 'restarting'
  if (snapshot.value.restartRequest?._tag === 'ActionRequired')
    return 'restart: Action required'
  return undefined
})

const selectionModeHint = computed(() => snapshot.value.selectionMode === 'auto'
  ? 'The service reviews every eligible pull request. Switch to Manual to select each one.'
  : 'The service waits for you. Select a pull request with Review and repair, or the harlan-agent-review label.')

/** Provider marks, so the running agent runtime is readable at a glance. */
const providerIcons: Record<AgentProviderName, string> = {
  codex: 'i-simple-icons-openai',
  opencode: 'i-simple-icons-opencode',
}

const providerLabels: Record<AgentProviderName, string> = {
  codex: 'Codex',
  opencode: 'opencode',
}

const profileState = computed(() => agentProfileState(snapshot.value, loading.value))

/**
 * One control for the Agent provider, its model, and its reasoning effort.
 *
 * Switching the provider clears the model and the reasoning effort, because a
 * model belongs to one provider and the service refuses the other provider's.
 * Follow configuration hands the whole choice back to the configuration file.
 * Automatic hands it to remaining capacity, so the provider with room answers
 * the next turn and the reserve stays for interactive work.
 */
const agentSelectionItems = computed<DropdownMenuItem[][]>(() => {
  if (profileState.value._tag !== 'Available')
    return []
  const selection = snapshot.value.agentSelection
  const pinned = selection._tag === 'Pinned' ? selection : null
  // While the selection follows the configuration, the configured provider
  // decides, so its own models and role defaults are what the menu offers.
  const provider = pinned?.provider ?? profileState.value.profile.provider
  const pin = (model: AgentModel | null, reasoningEffort: CodexReasoningEffort | null): AgentSelection =>
    ({ _tag: 'Pinned', provider, model, reasoningEffort })
  return [
    [
      { label: 'Agent provider', type: 'label' },
      {
        label: 'Follow configuration',
        icon: 'i-lucide-file-cog',
        type: 'checkbox',
        checked: selection._tag === 'FollowsConfiguration',
        onUpdateChecked: () => switchAgent({ _tag: 'FollowsConfiguration' }),
      },
      {
        label: 'Automatic',
        icon: 'i-lucide-gauge',
        type: 'checkbox',
        checked: selection._tag === 'Automatic',
        onUpdateChecked: () => switchAgent({ _tag: 'Automatic', order: [...snapshot.value.agentProviderOrder] }),
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
      ...snapshot.value.agentModels[provider].map(model => ({
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
      ...snapshot.value.reasoningEfforts.map(reasoningEffort => ({
        label: reasoningEffort,
        type: 'checkbox' as const,
        checked: pinned?.reasoningEffort === reasoningEffort,
        onUpdateChecked: () => switchAgent(pin(pinned?.model ?? null, reasoningEffort)),
      })),
    ],
  ]
})

const documentTitle = computed(() => decisions.value.length > 0
  ? `(${decisions.value.length}) Harlan GitHub Agent`
  : 'Harlan GitHub Agent')

/**
 * A tab icon has 16 pixels, so it carries one signal: colour. Amber means a decision
 * is waiting, red means a repository is failing, emerald means nothing needs you.
 * Literal hex is unavoidable inside a data URI; these track the design tokens by hand.
 */
const faviconHref = computed(() => {
  const fill = blockingIncidents.value > 0 || unhealthyRepositories.value > 0
    ? '#dc2626'
    : decisions.value.length > 0 || incidents.value.length > 0 ? '#d97706' : '#059669'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#171717"/><circle cx="16" cy="16" r="7" fill="${fill}"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
})

function toggleColorMode(): void {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
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

function notifyDecisions(fresh: QueueEntry[]): void {
  const first = fresh[0]
  if (first === undefined || Notification.permission !== 'granted')
    return
  const body = fresh.length === 1
    ? `${first.repository} #${first.number}: ${first.title}`
    : `${fresh.length} items need your decision.`
  const notification = new Notification('Harlan GitHub Agent', { body, tag: 'harlan-agent-decisions' })
  notification.onclick = () => {
    window.focus()
    notification.close()
  }
}

watch(decisions, (entries) => {
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

onMounted(() => {
  start()
  notificationsSupported.value = 'Notification' in window
  if (notificationsSupported.value && notificationPreference.value && Notification.permission === 'granted')
    notificationsOn.value = true
})

useHead({
  htmlAttrs: { lang: 'en' },
  title: documentTitle,
  link: [{ rel: 'icon', type: 'image/svg+xml', href: faviconHref }],
})
</script>

<template>
  <div class="min-h-screen">
    <a href="#main-content" class="skip-link">
      Skip to content
    </a>

    <header class="sticky top-0 z-50 border-b border-default bg-default/85 backdrop-blur">
      <div class="mx-auto flex max-w-[100rem] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-2.5 sm:px-6 lg:px-8">
        <div class="flex min-w-0 items-center gap-5">
          <NuxtLink to="/" aria-label="Harlan GitHub Agent" class="entity-link flex min-w-0 items-center gap-2.5 no-underline">
            <span class="grid size-8 shrink-0 place-items-center rounded-md bg-inverted text-inverted">
              <UIcon name="i-lucide-bot" class="size-4.5" aria-hidden="true" />
            </span>
            <span class="hidden truncate text-base font-semibold tracking-tight sm:inline">Harlan GitHub Agent</span>
          </NuxtLink>

          <nav aria-label="Dashboard pages" class="flex items-center gap-0.5">
            <UButton
              v-for="page in pages"
              :key="page.to"
              :to="page.to"
              :icon="page.icon"
              :ui="{ leadingIcon: 'hidden sm:block' }"
              :color="route.path === page.to ? 'primary' : 'neutral'"
              :variant="route.path === page.to ? 'soft' : 'ghost'"
              :class="route.path === page.to ? statusClass('primary') : undefined"
              :aria-current="route.path === page.to ? 'page' : undefined"
            >
              {{ page.label }}
              <span v-if="page.count > 0" class="font-mono text-xs tabular-nums" :class="statusClass(page.tone)">{{ page.count }}</span>
            </UButton>
          </nav>
        </div>

        <div class="flex items-center gap-1">
          <UDropdownMenu v-if="profileState._tag === 'Available'" :items="agentSelectionItems" :content="{ align: 'end' }" :ui="{ content: 'w-60' }">
            <UButton
              :icon="providerIcons[profileState.profile.provider]"
              trailing-icon="i-lucide-chevron-down"
              color="neutral"
              variant="ghost"
              :loading="controlPending"
              title="Switch the Agent provider, model, or reasoning effort. A switch starts the next agent turn."
            >
              <span class="hidden lg:inline">{{ providerLabels[profileState.profile.provider] }}</span>
            </UButton>
          </UDropdownMenu>
          <UButton
            v-else
            :icon="profileState._tag === 'Unavailable' ? 'i-lucide-circle-slash-2' : undefined"
            :loading="profileState._tag === 'Loading'"
            color="neutral"
            variant="ghost"
            disabled
            :aria-label="profileState._tag === 'Loading' ? 'Agent provider loading' : 'Agent provider unavailable'"
          >
            <span class="hidden lg:inline">{{ profileState._tag === 'Loading' ? 'Loading' : 'Unavailable' }}</span>
          </UButton>
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
          <UButton
            v-if="snapshot.mutationsEnabled"
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="ghost"
            :loading="controlPending || snapshot.restartRequest?._tag === 'Restarting'"
            :disabled="controlPending || restartActive"
            :aria-label="restartActive ? 'Restart requested' : 'Restart after current work'"
            title="Finish active work, restart the service, then continue queued Tasks."
            @click="requestRestart"
          >
            <span class="hidden xl:inline">{{ restartActive ? 'Restart requested' : 'Restart after current work' }}</span>
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

      <div class="mx-auto flex max-w-[100rem] flex-wrap items-center gap-x-2 gap-y-1 border-t border-default px-4 py-1.5 font-mono text-xs text-muted sm:px-6 lg:px-8">
        <span
          class="size-1.5 shrink-0 rounded-full"
          :class="liveStatus === 'OPEN' ? 'live-dot bg-success' : 'bg-warning'"
          aria-hidden="true"
        />
        <span>{{ connectionLabel }}</span>
        <template v-if="profileState._tag === 'Available'">
          <span aria-hidden="true" class="text-dimmed">·</span>
          <span>{{ activeAgents.length }}/{{ profileState.profile.maximumActiveAgents }} agents</span>
        </template>
        <span aria-hidden="true" class="text-dimmed">·</span>
        <span :class="snapshot.mutationsEnabled ? statusClass('warning') : undefined">writes {{ snapshot.mutationsEnabled ? 'on' : 'off' }}</span>
        <template v-if="agentControlLabel">
          <span aria-hidden="true" class="text-dimmed">·</span>
          <span :class="statusClass('warning')">{{ agentControlLabel }}</span>
        </template>
        <template v-if="restartLabel">
          <span aria-hidden="true" class="text-dimmed">·</span>
          <span :class="statusClass(snapshot.restartRequest?._tag === 'ActionRequired' ? 'error' : 'warning')">{{ restartLabel }}</span>
        </template>
        <template v-if="snapshot.selectionMode === 'auto' && snapshot.openPullRequests >= snapshot.maxOpenPullRequests">
          <span aria-hidden="true" class="text-dimmed">·</span>
          <span
            :class="statusClass('warning')"
            :title="`Issue work stops above ${snapshot.maxOpenPullRequests} open pull requests.`"
          >{{ snapshot.openPullRequests }}/{{ snapshot.maxOpenPullRequests }} open pull requests</span>
        </template>
        <template v-if="snapshot.mutationsEnabled && snapshot.selectionMode === 'manual'">
          <span aria-hidden="true" class="text-dimmed">·</span>
          <span :class="statusClass('warning')">manual: you select each pull request</span>
        </template>
        <span aria-hidden="true" class="text-dimmed">·</span>
        <span class="text-dimmed">updated {{ relativeTime(snapshot.generatedAt) }}</span>
        <span v-if="incidents.length > 0" aria-hidden="true" class="text-dimmed">·</span>
        <NuxtLink
          v-if="incidents.length > 0"
          to="/#system"
          class="entity-link"
          :class="statusClass(blockingIncidents > 0 ? 'error' : 'warning')"
        >
          {{ incidents.length }} incident{{ incidents.length === 1 ? '' : 's' }}
        </NuxtLink>
      </div>
    </header>

    <main id="main-content" tabindex="-1" class="mx-auto max-w-[100rem] px-4 py-6 sm:px-6 lg:px-8">
      <div v-if="loadError" role="alert" class="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-error/40 bg-error/5 p-4 text-sm">
        <span class="status-error">{{ loadError }}</span>
        <UButton size="sm" color="error" variant="soft" @click="loadState">
          Retry
        </UButton>
      </div>

      <div v-if="controlError" role="alert" class="mb-6 rounded-md border border-error/40 bg-error/5 p-4 text-sm status-error">
        Agent control failed: {{ controlError }}
      </div>

      <div v-if="notificationError" role="alert" class="mb-6 rounded-md border border-warning/40 bg-warning/5 p-4 text-sm status-warning">
        {{ notificationError }}
      </div>

      <div v-if="isStale" role="status" class="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-warning/40 bg-warning/5 p-4 text-sm">
        <span class="status-warning">This is {{ relativeTime(snapshot.generatedAt) }}. The live connection is {{ connectionLabel.toLowerCase() }}, so the state below may have moved on.</span>
        <UButton size="sm" color="warning" variant="soft" @click="loadState">
          Reload now
        </UButton>
      </div>

      <div :class="isStale ? 'stale-content' : undefined">
        <slot />
      </div>
    </main>

    <footer class="mx-auto flex max-w-[100rem] flex-wrap gap-x-6 gap-y-1 px-4 pb-10 pt-12 font-mono text-xs text-dimmed sm:px-6 lg:px-8">
      <template v-if="profileState._tag === 'Available'">
        <span v-for="[role, label] in agentRoleLabels" :key="role">
          {{ label }}: {{ profileState.profile.roles[role].model }}<template v-if="profileState.profile.roles[role].reasoningEffort"> · {{ profileState.profile.roles[role].reasoningEffort }}</template>
        </span>
        <span class="inline-flex items-center gap-1.5">
          <UIcon :name="providerIcons[profileState.profile.provider]" class="size-4 shrink-0" aria-hidden="true" />
          {{ providerLabels[profileState.profile.provider] }} · {{ profileState.profile.maximumActiveAgents }} agents max
        </span>
      </template>
      <span v-else>Agent provider: {{ profileState._tag === 'Loading' ? 'Loading' : 'Unavailable' }}</span>
      <span>Loopback only · GitHub App scoped · Repository tokens isolated</span>
    </footer>
  </div>
</template>
