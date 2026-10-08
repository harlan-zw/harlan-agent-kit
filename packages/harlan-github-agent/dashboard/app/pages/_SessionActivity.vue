<script setup lang="ts">
import type { SessionTool } from '../utils/session.ts'
import SessionCode from './_SessionCode.vue'

const { tools, expanded = false } = defineProps<{ tools: SessionTool[], expanded?: boolean }>()
const emit = defineEmits<{ expanded: [value: boolean] }>()
const pending = computed(() => tools.some(tool => tool.status === 'running'))
const failed = computed(() => tools.filter(tool => tool.status === 'failed'))
const openRows = ref(new Set<string>())
const summary = computed(() => pending.value ? 'Running commands' : `${tools.length} ${tools.length === 1 ? 'activity' : 'activities'}`)
const icons = { command: 'i-octicon-terminal-16', files: 'i-octicon-file-diff-16', reasoning: 'i-octicon-comment-16', search: 'i-octicon-search-16', failure: 'i-octicon-alert-16' }
const statuses = { running: 'Running', passed: 'Passed', failed: 'Failed', finished: 'Finished', stopped: 'Stopped', interrupted: 'Interrupted' }

function toggleRow(id: string): void {
  const next = new Set(openRows.value)
  if (!next.delete(id))
    next.add(id)
  openRows.value = next
}
</script>

<template>
  <div class="my-5 min-w-0">
    <button type="button" class="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted transition-colors hover:bg-muted" :aria-expanded="expanded" @click="emit('expanded', !expanded)">
      <UIcon :name="pending ? 'i-octicon-sync-16' : 'i-octicon-terminal-16'" class="size-4 shrink-0" />
      <span>{{ summary }}</span>
      <span v-if="failed.length" class="ml-2 status-error">{{ failed.length }} failed</span>
      <UIcon :name="expanded ? 'i-octicon-chevron-up-16' : 'i-octicon-chevron-down-16'" class="ml-auto size-4" />
    </button>
    <div v-if="expanded" class="mt-1 overflow-hidden rounded-md border border-default">
      <div v-for="tool in tools" :key="tool.id" class="border-b border-default last:border-b-0">
        <button type="button" class="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted" :aria-expanded="openRows.has(tool.id)" :title="tool.label" @click="toggleRow(tool.id)">
          <UIcon :name="icons[tool.kind]" class="size-4 shrink-0 text-muted" />
          <span class="min-w-0 flex-1 truncate" :class="tool.kind === 'command' ? 'font-mono' : ''">{{ tool.label }}</span>
          <span class="shrink-0 text-muted" :class="tool.status === 'failed' ? 'status-error' : ''">{{ statuses[tool.status] }}</span>
          <UIcon :name="openRows.has(tool.id) ? 'i-octicon-chevron-up-16' : 'i-octicon-chevron-down-16'" class="size-4 shrink-0 text-muted" />
        </button>
        <div v-if="openRows.has(tool.id)" class="min-w-0 px-3 pb-3">
          <SessionCode v-if="tool.kind === 'command'" :text="tool.label" language="sh" />
          <pre v-if="tool.detail" class="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-sm leading-6" tabindex="0" :aria-label="`${tool.kind} details`">{{ tool.detail }}</pre>
          <p v-else-if="tool.status === 'running'" class="text-sm text-muted" role="status">
            Waiting for command output.
          </p>
        </div>
      </div>
    </div>
    <p v-for="tool in failed" :key="`${tool.id}-failure`" class="mt-2 break-words rounded-md border border-error/30 bg-error/5 p-3 text-sm" role="status">
      {{ tool.detail }}
    </p>
    <p v-if="pending && !expanded" class="mt-1 truncate pl-8 font-mono text-sm text-muted">
      {{ tools.find(tool => tool.status === 'running')?.label }}
    </p>
  </div>
</template>
