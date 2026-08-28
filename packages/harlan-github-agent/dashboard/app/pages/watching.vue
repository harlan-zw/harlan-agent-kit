<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { repositoryState, statusClass } from '../utils/dashboard.ts'

const {
  snapshot,
  relativeTime,
  repositoryPending,
  setRepositoryPaused,
  setRepositoryWritesEnabled,
  restoreItem,
  dismissPending,
  dismissErrors,
  dismissKey,
} = useDashboard()

const repositoryQuery = ref('')
const subjectFilter = ref<'all' | 'issue' | 'pull_request'>('all')

const filteredRepositories = computed(() => {
  const query = repositoryQuery.value.trim().toLowerCase()
  return query.length === 0
    ? snapshot.value.repositories
    : snapshot.value.repositories.filter(repository => repository.github.toLowerCase().includes(query))
})

/** Dismissed items have their own list below, so they never pad this one. */
const openSubjects = computed(() => snapshot.value.items.filter(subject => !subject.dismissed))

const filteredSubjects = computed(() => subjectFilter.value === 'all'
  ? openSubjects.value
  : openSubjects.value.filter(subject => subject.kind === subjectFilter.value))

const dismissedSubjects = computed(() => snapshot.value.items.filter(subject => subject.dismissed))

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement))
    return false
  return target.isContentEditable || /^(?:input|textarea|select)$/i.test(target.tagName)
}

useEventListener('keydown', (event: KeyboardEvent) => {
  if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target) || event.key !== '/')
    return
  event.preventDefault()
  document.querySelector<HTMLInputElement>('input[aria-label="Filter repositories"]')?.focus()
})

useHead({
  meta: [{ name: 'description', content: 'Repository health and the open pull requests and issues being polled.' }],
})
</script>

<template>
  <div class="grid items-start gap-x-10 gap-y-10 xl:grid-cols-2">
    <section class="min-w-0" aria-labelledby="repositories-heading">
      <div class="zone-header">
        <h1 id="repositories-heading" class="field-label">
          Repositories
        </h1>
        <span class="font-mono text-sm text-dimmed">{{ filteredRepositories.length }}</span>
        <hr class="zone-rule">
        <UInput
          v-model="repositoryQuery"
          size="sm"
          icon="i-lucide-search"
          placeholder="Filter"
          aria-label="Filter repositories"
          class="w-40 shrink-0 sm:w-56"
        />
      </div>

      <div class="overflow-x-auto border-y border-default">
        <table v-if="filteredRepositories.length > 0" class="w-full min-w-[44rem] border-collapse text-left">
          <caption class="sr-only">
            Repository health and latest poll state
          </caption>
          <thead class="border-b border-default">
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
                Writes
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
                  v-if="repository.writesEnabled"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-lock-open"
                  :loading="repositoryPending === repository.github"
                  :disabled="repositoryPending !== undefined"
                  :aria-label="`Disable writes for ${repository.github}`"
                  @click="setRepositoryWritesEnabled(repository.github, false)"
                >
                  Enabled
                </UButton>
                <ConfirmButton
                  v-else
                  label="Disabled"
                  confirm-label="Enable writes"
                  :aria-label="`Enable writes for ${repository.github}`"
                  :confirm-aria-label="`Confirm enabling writes for ${repository.github}`"
                  color="warning"
                  icon="i-lucide-lock"
                  size="xs"
                  :loading="repositoryPending === repository.github"
                  :disabled="repositoryPending !== undefined"
                  @confirm="setRepositoryWritesEnabled(repository.github, true)"
                />
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

      <p v-for="repository in filteredRepositories.filter(candidate => candidate.lastError !== null)" :key="`${repository.github}-error`" class="status-error mt-3 text-sm">
        {{ repository.github }}: {{ repository.lastError }}
      </p>
    </section>

    <section class="min-w-0" aria-labelledby="open-items-heading">
      <div class="zone-header">
        <h2 id="open-items-heading" class="field-label">
          Open
        </h2>
        <span class="font-mono text-sm text-dimmed">{{ filteredSubjects.length }}</span>
        <hr class="zone-rule">
        <div class="flex shrink-0 items-center gap-1" aria-label="Filter pull requests and issues">
          <UButton
            v-for="filter in [
              { label: 'All', value: 'all' as const },
              { label: 'PRs', value: 'pull_request' as const },
              { label: 'Issues', value: 'issue' as const },
            ]"
            :key="filter.value"
            size="xs"
            :color="subjectFilter === filter.value ? 'primary' : 'neutral'"
            :variant="subjectFilter === filter.value ? 'soft' : 'ghost'"
            :aria-pressed="subjectFilter === filter.value"
            @click="subjectFilter = filter.value"
          >
            {{ filter.label }}
          </UButton>
        </div>
      </div>

      <ul v-if="filteredSubjects.length > 0" class="divide-y divide-default border-y border-default" role="list">
        <li
          v-for="subject in filteredSubjects"
          :key="`${subject.repository}:${subject.kind}:${subject.number}`"
          class="flex items-start justify-between gap-4 py-2.5 transition-colors hover:bg-muted/40"
        >
          <ItemIdentity
            :author="subject.author"
            :title="subject.title"
            :url="subject.url"
            :repository="subject.repository"
            :kind="subject.kind"
            :number="subject.number"
          />
          <span class="shrink-0 font-mono text-xs text-dimmed">{{ relativeTime(subject.observedAt) }}</span>
        </li>
      </ul>
      <p v-else class="font-mono text-sm text-dimmed">
        No open pull requests or issues. The agent is waiting for a human issue or pull request.
      </p>

      <!-- The only place a Dismissal can be undone, so it has to be findable. -->
      <template v-if="dismissedSubjects.length > 0">
        <div class="zone-header mt-8">
          <h2 class="field-label">
            Dismissed
          </h2>
          <span class="font-mono text-sm text-dimmed">{{ dismissedSubjects.length }}</span>
          <hr class="zone-rule">
        </div>
        <p class="mb-3 text-sm text-muted">
          No agent runs on these, whatever changes. Restoring lets the next poll queue work again.
        </p>
        <ul class="divide-y divide-default border-y border-default" role="list">
          <li
            v-for="subject in dismissedSubjects"
            :key="`${subject.repository}:${subject.kind}:${subject.number}`"
            class="flex items-start justify-between gap-4 py-2.5"
          >
            <ItemIdentity
              :author="subject.author"
              :title="subject.title"
              :url="subject.url"
              :repository="subject.repository"
              :kind="subject.kind"
              :number="subject.number"
            />
            <div class="shrink-0">
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-undo-2"
                :loading="dismissPending === dismissKey(subject.repository, subject.number)"
                :disabled="dismissPending !== undefined"
                :aria-label="`Restore ${subject.repository} ${subject.kind === 'issue' ? 'issue' : 'pull request'} ${subject.number}`"
                @click="restoreItem(subject.repository, subject.number)"
              >
                Restore
              </UButton>
              <p v-if="dismissErrors[dismissKey(subject.repository, subject.number)]" role="alert" class="status-error mt-1 text-sm">
                {{ dismissErrors[dismissKey(subject.repository, subject.number)] }}
              </p>
            </div>
          </li>
        </ul>
      </template>
    </section>
  </div>
</template>
