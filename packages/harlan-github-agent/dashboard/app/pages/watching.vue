<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { RepositoryStatus } from '../../../src/types.ts'
import type { OpenItemsFilter, RepositoryAction } from '../utils/watching.ts'
import { useEventListener } from '@vueuse/core'
import ConfirmModal from '../components/ConfirmModal.vue'
import { repositoryState } from '../utils/dashboard.ts'
import { isTypingTarget, overlayOpen } from '../utils/keyboard.ts'
import {
  dismissedItems,
  enableWritesConsequence,
  filterRepositories,
  openItemsEmptyLine,
  openItemsFilter,
  repositoriesEmpty,
  repositoriesEmptyLine,
  repositoryActionIcon,
  repositoryActionLabel,
  repositoryActions,
  repositoryAgentsLabel,
  repositoryWritesLabel,
} from '../utils/watching.ts'

/**
 * What is being polled. Two zones: the repository table with its per-row
 * controls, and the open pull requests and issues. Dismissed items sit under
 * Open because Restore lives nowhere else.
 */
const {
  snapshot,
  loading,
  relativeTime,
  repositoryPending,
  controlError,
  setRepositoryPaused,
  setRepositoryWritesEnabled,
  restoreItem,
  dismissPending,
  dismissErrors,
  dismissKey,
} = useDashboard()

const repositoryQuery = ref('')
const itemsFilter = ref<OpenItemsFilter>('all')
const filterInput = useTemplateRef('filterInput')
/** The repository whose Enable writes is waiting for confirmation. */
const enabling = ref<RepositoryStatus>()

const repositories = computed(() => filterRepositories(snapshot.value.repositories, repositoryQuery.value))
const repositoriesEmptyReason = computed(() => repositoriesEmpty(snapshot.value.repositories.length, repositoryQuery.value))
const openItems = computed(() => openItemsFilter(snapshot.value.items, itemsFilter.value))
const dismissed = computed(() => dismissedItems(snapshot.value.items))

const itemFilters: Array<{ label: string, value: OpenItemsFilter }> = [
  { label: 'All', value: 'all' },
  { label: 'Pull requests', value: 'pull_request' },
  { label: 'Issues', value: 'issue' },
]

const busy = computed(() => repositoryPending.value !== undefined)

function act(repository: RepositoryStatus, action: RepositoryAction): void {
  switch (action._tag) {
    case 'Pause': return void setRepositoryPaused(repository.github, true)
    case 'Resume': return void setRepositoryPaused(repository.github, false)
    case 'DisableWrites': return void setRepositoryWritesEnabled(repository.github, false)
    case 'EnableWrites':
      enabling.value = repository
  }
}

function menuItems(repository: RepositoryStatus): DropdownMenuItem[] {
  return repositoryActions(repository).map(action => ({
    label: repositoryActionLabel(action),
    icon: repositoryActionIcon(action),
    disabled: busy.value,
    onSelect: () => act(repository, action),
  }))
}

async function confirmEnableWrites(): Promise<void> {
  if (enabling.value === undefined)
    return
  await setRepositoryWritesEnabled(enabling.value.github, true)
  if (controlError.value === undefined)
    enabling.value = undefined
}

const enableOpen = computed({
  get: () => enabling.value !== undefined,
  set: (value: boolean) => {
    if (!value)
      enabling.value = undefined
  },
})

function itemLabel(item: { kind: 'issue' | 'pull_request' }): string {
  return item.kind === 'issue' ? 'issue' : 'pull request'
}

useEventListener('keydown', (event: KeyboardEvent) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.key !== '/' || isTypingTarget(event.target) || overlayOpen(document))
    return
  event.preventDefault()
  filterInput.value?.inputRef?.focus()
})

usePageTitle('Watching')
useHead({
  meta: [{ name: 'description', content: 'Repository health and the open pull requests and issues being polled.' }],
})
</script>

<template>
  <div class="grid items-start gap-10 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
    <h1 class="sr-only">
      Watching
    </h1>
    <section class="flex min-w-0 flex-col gap-3" aria-label="Repositories">
      <div class="flex items-center gap-3">
        <ColumnHeading label="Repositories" :count="repositories.length" class="min-w-0 flex-1" />
        <UInput
          ref="filterInput"
          v-model="repositoryQuery"
          size="sm"
          icon="i-octicon-search-16"
          placeholder="Filter repositories"
          aria-label="Filter repositories"
          class="w-40 shrink-0 sm:w-56"
        />
      </div>

      <div v-if="loading" class="flex flex-col gap-px" aria-busy="true">
        <USkeleton v-for="row in 3" :key="row" class="h-11 rounded-sm" />
      </div>

      <!-- Positioned, so the sr-only cells inside cannot push the document wider than the viewport. -->
      <div v-else-if="repositories.length > 0" class="relative overflow-x-auto border-y border-default">
        <table class="w-full border-collapse text-left">
          <caption class="sr-only">
            Repositories being polled, their health, and their controls
          </caption>
          <thead class="border-b border-default">
            <tr>
              <th scope="col" class="field-label py-2 pr-3 pl-2">
                Repository
              </th>
              <th scope="col" class="field-label py-2 pr-3">
                Health
              </th>
              <th scope="col" class="field-label py-2 pr-3 text-right">
                Open
              </th>
              <th scope="col" class="field-label py-2 pr-3">
                Ownership
              </th>
              <th scope="col" class="field-label py-2 pr-3">
                Writes
              </th>
              <th scope="col" class="field-label py-2 pr-3">
                Agents
              </th>
              <th scope="col" class="field-label py-2 pr-3">
                Last success
              </th>
              <th scope="col" class="py-2 pr-2">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <!-- One body per repository, so a poll error can sit under its row without breaking the dividers. -->
          <tbody
            v-for="repository in repositories"
            :key="repository.github"
            class="border-b border-default transition-colors last:border-b-0 hover:bg-muted"
          >
            <tr class="h-11">
              <th scope="row" class="whitespace-nowrap py-2 pr-3 pl-2 font-mono text-sm font-normal">
                <a :href="`https://github.com/${repository.github}`" target="_blank" rel="noreferrer" class="entity-link">{{ repository.github }}</a>
              </th>
              <td class="py-2 pr-3">
                <StateBadge :tone="repositoryState(repository).tone" :label="repositoryState(repository).label" />
              </td>
              <td class="py-2 pr-3 text-right font-mono text-sm">
                <a :href="`https://github.com/${repository.github}/issues`" target="_blank" rel="noreferrer" class="entity-link">{{ repository.subjectCount }}<span class="sr-only"> open on GitHub</span></a>
              </td>
              <td class="py-2 pr-3 text-sm text-muted">
                {{ repository.ownership }}
              </td>
              <td class="py-2 pr-3 text-sm" :class="repositoryWritesLabel(repository) === 'Enabled' ? 'text-default' : 'text-muted'">
                {{ repositoryWritesLabel(repository) }}
              </td>
              <td class="py-2 pr-3 text-sm" :class="repository.paused ? 'text-muted' : 'text-default'">
                {{ repositoryAgentsLabel(repository) }}
              </td>
              <td class="whitespace-nowrap py-2 pr-3 font-mono text-sm text-dimmed">
                {{ relativeTime(repository.lastSuccessAt) }}
              </td>
              <td class="py-1 pr-2 text-right">
                <UDropdownMenu :items="menuItems(repository)" :content="{ align: 'end' }">
                  <UButton
                    icon="i-octicon-kebab-horizontal-16"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    square
                    :loading="repositoryPending === repository.github"
                    :aria-label="`Actions for ${repository.github}`"
                  />
                </UDropdownMenu>
              </td>
            </tr>
            <tr v-if="repository.lastError !== null">
              <td colspan="8" class="status-error pb-2.5 pl-2 pr-2 text-sm whitespace-normal">
                {{ repository.lastError }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-else-if="repositoriesEmptyReason" class="text-sm text-dimmed">
        {{ repositoriesEmptyLine(repositoriesEmptyReason) }}
      </p>
    </section>

    <div class="flex min-w-0 flex-col gap-10">
      <section class="flex min-w-0 flex-col gap-3" aria-label="Open">
        <div class="flex items-center gap-3">
          <ColumnHeading label="Open" :count="openItems.length" class="min-w-0 flex-1" />
          <div class="flex shrink-0 items-center gap-1" role="group" aria-label="Filter by kind">
            <UButton
              v-for="filter in itemFilters"
              :key="filter.value"
              size="xs"
              color="neutral"
              :variant="itemsFilter === filter.value ? 'outline' : 'ghost'"
              :aria-pressed="itemsFilter === filter.value"
              @click="itemsFilter = filter.value"
            >
              {{ filter.label }}
            </UButton>
          </div>
        </div>

        <div v-if="loading" class="flex flex-col gap-px" aria-busy="true">
          <USkeleton v-for="row in 3" :key="row" class="h-11 rounded-sm" />
        </div>

        <ul v-else-if="openItems.length > 0" class="divide-y divide-default border-y border-default" role="list">
          <li
            v-for="item in openItems"
            :key="`${item.repository}#${item.number}`"
            class="flex min-h-11 items-center justify-between gap-3 px-2 py-2 transition-colors hover:bg-muted"
          >
            <EntityIdentity
              :author="item.author"
              :title="item.title"
              :url="item.url"
              :repository="item.repository"
              :kind="item.kind"
              :number="item.number"
              size="sm"
            />
            <time class="shrink-0 font-mono text-sm text-dimmed" :datetime="item.observedAt">{{ relativeTime(item.observedAt) }}</time>
          </li>
        </ul>

        <p v-else class="text-sm text-dimmed">
          {{ openItemsEmptyLine(itemsFilter) }}
        </p>
      </section>

      <!-- The only place a Dismissal can be undone. Absent until one exists. -->
      <section v-if="dismissed.length > 0" class="flex min-w-0 flex-col gap-3" aria-label="Dismissed">
        <ColumnHeading label="Dismissed" :count="dismissed.length" />
        <ul class="divide-y divide-default border-y border-default" role="list">
          <li
            v-for="item in dismissed"
            :key="`${item.repository}#${item.number}`"
            class="flex min-h-11 flex-col gap-1 px-2 py-2 transition-colors hover:bg-muted"
          >
            <div class="flex items-center justify-between gap-3">
              <EntityIdentity
                :author="item.author"
                :title="item.title"
                :url="item.url"
                :repository="item.repository"
                :kind="item.kind"
                :number="item.number"
                size="sm"
              />
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                icon="i-octicon-undo-16"
                class="shrink-0"
                :loading="dismissPending === dismissKey(item.repository, item.number)"
                :disabled="dismissPending !== undefined"
                :aria-label="`Restore ${item.repository} ${itemLabel(item)} ${item.number}`"
                @click="restoreItem(item.repository, item.number)"
              >
                Restore
              </UButton>
            </div>
            <p v-if="dismissErrors[dismissKey(item.repository, item.number)]" role="alert" class="status-error text-sm">
              {{ dismissErrors[dismissKey(item.repository, item.number)] }}
            </p>
          </li>
        </ul>
      </section>
    </div>

    <ConfirmModal
      v-model:open="enableOpen"
      :title="`Enable writes for ${enabling?.github ?? 'this repository'}?`"
      :consequence="enableWritesConsequence()"
      confirm-label="Enable writes"
      tone="primary"
      :pending="enabling !== undefined && repositoryPending === enabling.github"
      :error="enabling === undefined ? null : controlError ?? null"
      @confirm="confirmEnableWrites"
    />
  </div>
</template>
