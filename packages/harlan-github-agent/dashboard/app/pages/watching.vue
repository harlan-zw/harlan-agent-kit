<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { RepositoryStatus } from '../../../src/types.ts'
import type { OpenItemsFilter, RepositoryAction } from '../utils/watching.ts'
import { useEventListener } from '@vueuse/core'
import ConfirmModal from '../components/ConfirmModal.vue'
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
  repositoryFlags,
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
    <section class="min-w-0" aria-label="Repositories">
      <UiSectionHeader title="Repositories">
        <template #after-title>
          <span class="font-mono text-sm font-normal text-muted">{{ repositories.length }}</span>
        </template>
        <template #actions>
          <UInput
            ref="filterInput"
            v-model="repositoryQuery"
            size="sm"
            icon="i-octicon-search-16"
            placeholder="Filter repositories"
            aria-label="Filter repositories"
            class="w-40 sm:w-56"
          />
        </template>
      </UiSectionHeader>

      <div v-if="loading" class="flex flex-col gap-px" aria-busy="true">
        <USkeleton v-for="row in 3" :key="row" class="h-10 rounded-sm" />
      </div>

      <!-- Flags name the exceptions. A healthy row carries none, so the eye lands on the one that does. -->
      <UiTableShell v-else-if="repositories.length > 0" label="Repositories being polled and their controls" size="sm" row-hover>
        <template #head>
          <UiTableTh>Repository</UiTableTh>
          <UiTableTh numeric>
            Open
          </UiTableTh>
          <UiTableTh visible-from="sm">
            Ownership
          </UiTableTh>
          <UiTableTh align="right">
            Last success
          </UiTableTh>
          <UiTableTh align="right">
            <span class="sr-only">Actions</span>
          </UiTableTh>
        </template>
        <tr v-for="repository in repositories" :key="repository.github">
          <UiTableTd row-header size="sm">
            <span class="flex flex-wrap items-center gap-2">
              <a :href="`https://github.com/${repository.github}`" target="_blank" rel="noreferrer" class="entity-link whitespace-nowrap font-mono text-sm"><RepositoryIdentity :repository="repository.github" /></a>
              <UiStatusBadge v-for="flag in repositoryFlags(repository)" :key="flag.label" :status="flag.tone" :label="flag.label" size="sm" />
            </span>
            <p v-if="repository.lastError !== null" class="status-error mt-1 whitespace-normal text-sm">
              {{ repository.lastError }}
            </p>
          </UiTableTd>
          <UiTableTd numeric size="sm">
            <a :href="`https://github.com/${repository.github}/issues`" target="_blank" rel="noreferrer" class="entity-link font-mono text-sm" :class="repository.subjectCount === 0 ? 'text-dimmed' : undefined">{{ repository.subjectCount }}<span class="sr-only"> open on GitHub</span></a>
          </UiTableTd>
          <UiTableTd size="sm" visible-from="sm">
            <span class="text-sm text-muted">{{ repository.ownership }}</span>
          </UiTableTd>
          <UiTableTd align="right" size="sm">
            <span class="whitespace-nowrap font-mono text-sm text-dimmed">{{ relativeTime(repository.lastSuccessAt) }}</span>
          </UiTableTd>
          <UiTableTd align="right" size="sm" no-padding>
            <UDropdownMenu :items="menuItems(repository)" :content="{ align: 'end' }">
              <UButton
                icon="i-octicon-kebab-horizontal-16"
                color="neutral"
                variant="ghost"
                size="xs"
                square
                class="me-1"
                :loading="repositoryPending === repository.github"
                :aria-label="`Actions for ${repository.github}`"
              />
            </UDropdownMenu>
          </UiTableTd>
        </tr>
      </UiTableShell>

      <UiEmptyState v-else-if="repositoriesEmptyReason" compact icon="search" title="No repositories" :description="repositoriesEmptyLine(repositoriesEmptyReason)" />
    </section>

    <div class="flex min-w-0 flex-col gap-10">
      <section class="min-w-0" aria-label="Open">
        <UiSectionHeader title="Open">
          <template #after-title>
            <span class="font-mono text-sm font-normal text-muted">{{ openItems.length }}</span>
          </template>
          <template #actions>
            <div class="flex items-center gap-1" role="group" aria-label="Filter by kind">
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
          </template>
        </UiSectionHeader>

        <div v-if="loading" class="flex flex-col gap-px" aria-busy="true">
          <USkeleton v-for="row in 3" :key="row" class="h-10 rounded-sm" />
        </div>

        <ul v-else-if="openItems.length > 0" class="divide-y divide-default border-y border-default" role="list">
          <li
            v-for="item in openItems"
            :key="`${item.repository}#${item.number}`"
            class="flex min-h-11 items-center px-2 py-2 transition-colors hover:bg-muted"
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
          </li>
        </ul>

        <UiEmptyState v-else compact icon="empty" title="Nothing open" :description="openItemsEmptyLine(itemsFilter)" />
      </section>

      <!-- The only place a Dismissal can be undone. Absent until one exists. -->
      <section v-if="dismissed.length > 0" class="min-w-0" aria-label="Dismissed">
        <UiSectionHeader title="Dismissed">
          <template #after-title>
            <span class="font-mono text-sm font-normal text-muted">{{ dismissed.length }}</span>
          </template>
        </UiSectionHeader>
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
