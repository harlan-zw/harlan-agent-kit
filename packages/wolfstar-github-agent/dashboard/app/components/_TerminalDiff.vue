<script setup lang="ts">
import type { VirtualizedFileDiff, Virtualizer } from '@pierre/diffs'
import type {
  PullRequestDiffInventory,
  TerminalDiffContent,
  TerminalDiffError,
  TerminalDiffInventory,
  TerminalDiffSource,
} from '../utils/terminal-diff'
import { useElementSize, useVirtualList } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import {
  parsePullRequestDiffInventory,
  parseTerminalDiffContent,
  parseTerminalDiffInventory,
  prepareTerminalDiffContent,
  terminalDiffParseOptions,
} from '../utils/terminal-diff'

type DiffTarget =
  | { _tag: 'Session'; sessionId: string; comparison?: { base: string; head: string } }
  | { _tag: 'PullRequest'; repository: string; number: number; base: string; head: string }
const { target } = defineProps<{ target: DiffTarget }>()
const emit = defineEmits<{ close: [] }>()
type InventoryState =
  | { _tag: 'Loading' }
  | { _tag: 'Ready'; value: TerminalDiffInventory | PullRequestDiffInventory }
  | { _tag: 'Failure'; error: TerminalDiffError }
type FileState =
  | { _tag: 'Idle' }
  | { _tag: 'Loading' }
  | { _tag: 'Ready'; value: TerminalDiffContent }
  | { _tag: 'Failure'; error: TerminalDiffError }
const inventory = shallowRef<InventoryState>({ _tag: 'Loading' })
const file = shallowRef<FileState>({ _tag: 'Idle' })
const source = shallowRef<TerminalDiffSource>({ _tag: 'Working' })
const selectedPath = ref('')
const chosenStyle = ref<'split' | 'unified'>()
const scroll = useTemplateRef<HTMLElement>('scroll')
const { width: paneWidth } = useElementSize(scroll)
const style = computed({
  get: () => chosenStyle.value ?? (paneWidth.value > 0 && paneWidth.value < 640 ? 'unified' : 'split'),
  set: (value: 'split' | 'unified') => {
    chosenStyle.value = value
  },
})
const content = useTemplateRef<HTMLElement>('content')
const colorMode = useColorMode()
const terminalHost = useTerminalHost()
const targetKey = computed(() => JSON.stringify(target))
let listRequest: AbortController | undefined
let fileRequest: AbortController | undefined
let renderer: VirtualizedFileDiff | undefined
let virtualizer: Virtualizer | undefined
let renderEpoch = 0
let mounted = false

const files = computed(() => (inventory.value._tag === 'Ready' ? inventory.value.value.files : []))
const {
  list: visibleFiles,
  containerProps,
  wrapperProps,
  scrollTo,
} = useVirtualList(files, { itemHeight: 44, overscan: 8 })
const incomplete = computed(
  () =>
    inventory.value._tag === 'Ready' &&
    'coverage' in inventory.value.value &&
    inventory.value.value.coverage._tag === 'Incomplete',
)
const loading = computed(() => inventory.value._tag === 'Loading' || file.value._tag === 'Loading')
const error = computed(() => {
  const reason =
    inventory.value._tag === 'Failure'
      ? inventory.value.error
      : file.value._tag === 'Failure'
        ? file.value.error
        : undefined
  if (!reason) return ''
  if (reason === 'Changed') return 'The file changed. Reload.'
  if (reason === 'Binary') return 'Binary file.'
  if (reason === 'TooLarge') return 'File exceeds the diff limit.'
  return 'Could not load the diff. Reload.'
})
function cleanRenderer(): void {
  renderEpoch++
  renderer?.cleanUp()
  virtualizer?.cleanUp()
  renderer = undefined
  virtualizer = undefined
  content.value?.replaceChildren()
}
function endpoint(query: Record<string, string>): string {
  if (target._tag === 'Session')
    return `/api/terminal/sessions/${encodeURIComponent(target.sessionId)}/diff?${new URLSearchParams(query)}`
  return `${terminalHost.controllerPath('/api/items/pull-request-diff')}?${new URLSearchParams({ ...query, repository: target.repository, number: String(target.number), base: target.base, head: target.head })}`
}
async function read(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error(`Diff request returned ${response.status}`)
  return response.json()
}
async function renderFile(value: TerminalDiffContent): Promise<void> {
  if (scroll.value) paneWidth.value = scroll.value.clientWidth
  cleanRenderer()
  const epoch = renderEpoch
  // Load the diff engine only when a selected file needs rendering.
  const library = await import('@pierre/diffs')
  await nextTick()
  if (!mounted || epoch !== renderEpoch || !scroll.value || !content.value) return
  virtualizer = new library.Virtualizer({ overscrollSize: 300, intersectionObserverMargin: 300 })
  virtualizer.setup(scroll.value, content.value)
  // Pierre owns its custom element and styles. Vue retains the surrounding mount.
  const fileContainer = document.createElement(library.DIFFS_TAG_NAME)
  content.value.append(fileContainer)
  renderer = new library.VirtualizedFileDiff(
    {
      diffStyle: style.value,
      themeType: colorMode.value === 'dark' ? 'dark' : 'light',
      disableFileHeader: true,
      lineDiffType: 'none',
      tokenizeMaxLength: 0,
      tokenizeMaxLineLength: 0,
      disableErrorHandling: true,
    },
    virtualizer,
  )
  const oldFile = {
    name: value.path,
    contents: value.oldText,
    lang: 'text' as const,
    cacheKey: `${value.generation}:old`,
  }
  const newFile = {
    name: value.path,
    contents: value.newText,
    lang: 'text' as const,
    cacheKey: `${value.generation}:new`,
  }
  let diff
  try {
    diff = library.parseDiffFromFile(oldFile, newFile, terminalDiffParseOptions)
  } catch (cause) {
    console.error('File exceeds the diff limit.', cause)
    cleanRenderer()
    file.value = { _tag: 'Failure', error: 'TooLarge' }
    return
  }
  renderer.render({ fileContainer, fileDiff: diff })
}
async function select(path: string): Promise<void> {
  if (inventory.value._tag !== 'Ready') return
  const snapshot = inventory.value.value.id
  fileRequest?.abort()
  cleanRenderer()
  selectedPath.value = path
  file.value = { _tag: 'Loading' }
  const request = new AbortController()
  fileRequest = request
  try {
    const result = parseTerminalDiffContent(await read(endpoint({ snapshot, path }), request.signal), path)
    if (request.signal.aborted || !mounted) return
    if (result._tag === 'Err') {
      file.value = { _tag: 'Failure', error: result.error }
      return
    }
    const prepared = prepareTerminalDiffContent(result.value)
    if (prepared._tag === 'Err') {
      file.value = { _tag: 'Failure', error: prepared.error }
      return
    }
    file.value = { _tag: 'Ready', value: prepared.value }
    if (scroll.value) scroll.value.scrollTop = 0
    await renderFile(result.value)
  } catch (cause) {
    // Closing or changing the selection intentionally cancels its request.
    if (request.signal.aborted || !mounted) return
    console.error('Could not load the diff.', cause)
    cleanRenderer()
    file.value = { _tag: 'Failure', error: 'Unavailable' }
  }
}
async function reload(): Promise<void> {
  listRequest?.abort()
  fileRequest?.abort()
  cleanRenderer()
  inventory.value = { _tag: 'Loading' }
  file.value = { _tag: 'Idle' }
  selectedPath.value = ''
  const request = new AbortController()
  listRequest = request
  const query: Record<string, string> = { source: source.value._tag.toLowerCase() }
  if (source.value._tag === 'Comparison') {
    query.base = source.value.base
    query.head = source.value.head
  }
  try {
    const response = await read(endpoint(query), request.signal)
    const result =
      target._tag === 'Session' ? parseTerminalDiffInventory(response) : parsePullRequestDiffInventory(response)
    if (request.signal.aborted || !mounted) return
    if (result._tag === 'Err') {
      inventory.value = { _tag: 'Failure', error: result.error }
      return
    }
    inventory.value = { _tag: 'Ready', value: result.value }
    await nextTick()
    if (request.signal.aborted || !mounted) return
    scrollTo(0)
    if (result.value.files[0]) await select(result.value.files[0].path)
  } catch (cause) {
    // Closing or changing the source intentionally cancels its request.
    if (request.signal.aborted || !mounted) return
    console.error('Could not load the diff.', cause)
    inventory.value = { _tag: 'Failure', error: 'Unavailable' }
  }
}
watch(
  targetKey,
  () => {
    const base = target._tag === 'PullRequest' ? target.base : target.comparison?.base
    const head = target._tag === 'PullRequest' ? target.head : target.comparison?.head
    source.value = base && head ? { _tag: 'Comparison', base, head } : { _tag: 'Working' }
  },
  { immediate: true },
)
watch([targetKey, source], () => {
  if (mounted) void reload()
})
watch([style, () => colorMode.value], () => {
  if (file.value._tag === 'Ready') {
    const pending = renderFile(file.value.value)
    const epoch = renderEpoch
    void pending.catch((cause: unknown) => {
      if (!mounted || epoch !== renderEpoch) return
      console.error('Could not load the diff.', cause)
      cleanRenderer()
      file.value = { _tag: 'Failure', error: 'Unavailable' }
    })
  }
})
onMounted(() => {
  mounted = true
  void reload()
})
onBeforeUnmount(() => {
  mounted = false
  listRequest?.abort()
  fileRequest?.abort()
  cleanRenderer()
})
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-default" aria-label="Diff" :aria-busy="loading">
    <header
      class="flex shrink-0 flex-wrap items-center gap-1 border-b border-default px-2 py-1 [&_button]:min-h-11 md:[&_button]:min-h-8"
    >
      <strong class="mr-2 text-sm font-semibold">Diff</strong>
      <template v-if="target._tag === 'Session'">
        <UButton
          label="Working tree"
          size="sm"
          color="neutral"
          :variant="source._tag === 'Working' ? 'soft' : 'ghost'"
          :aria-pressed="source._tag === 'Working'"
          @click="source = { _tag: 'Working' }"
        />
        <UButton
          label="Staged"
          size="sm"
          color="neutral"
          :variant="source._tag === 'Staged' ? 'soft' : 'ghost'"
          :aria-pressed="source._tag === 'Staged'"
          @click="source = { _tag: 'Staged' }"
        />
      </template>
      <div class="ml-auto flex items-center gap-1">
        <UButton
          label="Split"
          size="sm"
          color="neutral"
          :variant="style === 'split' ? 'soft' : 'ghost'"
          :aria-pressed="style === 'split'"
          @click="style = 'split'"
        />
        <UButton
          label="Unified"
          size="sm"
          color="neutral"
          :variant="style === 'unified' ? 'soft' : 'ghost'"
          :aria-pressed="style === 'unified'"
          @click="style = 'unified'"
        />
        <UButton label="Reload" size="sm" color="neutral" variant="ghost" @click="reload" />
        <UButton
          icon="i-octicon-x-16"
          aria-label="Close diff"
          size="sm"
          color="neutral"
          variant="ghost"
          @click="emit('close')"
        />
      </div>
    </header>
    <p v-if="incomplete" role="status" class="shrink-0 border-b border-default px-3 py-2 text-xs text-muted">
      GitHub returned the first 3,000 files. This diff is incomplete.
    </p>
    <div class="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav
        v-bind="containerProps"
        class="h-36 shrink-0 overflow-auto border-b border-default md:h-full md:w-48 md:border-r md:border-b-0"
        aria-label="Files"
      >
        <div v-bind="wrapperProps">
          <button
            v-for="item in visibleFiles"
            :key="item.data.path"
            type="button"
            class="flex h-11 w-full items-center gap-2 px-3 text-left text-sm hover:bg-muted"
            :class="selectedPath === item.data.path ? 'bg-elevated' : ''"
            :aria-current="selectedPath === item.data.path ? 'true' : undefined"
            :title="item.data.path"
            @click="select(item.data.path)"
          >
            <span class="w-6 shrink-0 font-mono text-xs text-muted">{{ item.data.status }}</span>
            <span class="min-w-0 truncate font-mono">{{ item.data.path }}</span>
          </button>
        </div>
      </nav>
      <div class="relative min-h-0 min-w-0 flex-1">
        <div
          v-if="loading"
          class="absolute inset-0 z-10 grid place-items-center bg-default/80"
          role="status"
          aria-label="Diff"
        >
          <UIcon
            name="i-octicon-sync-16"
            class="size-5 animate-spin text-muted motion-reduce:animate-none"
            aria-hidden="true"
          />
        </div>
        <p v-else-if="error" class="p-4 text-sm" role="alert">
          {{ error }}
        </p>
        <p v-else-if="inventory._tag === 'Ready' && files.length === 0" class="p-4 text-sm text-muted">
          No changed files.
        </p>
        <div
          v-show="!error && files.length > 0"
          ref="scroll"
          class="h-full min-h-0 overflow-auto"
          style="--diffs-font-family: var(--font-mono); --diffs-font-size: 14px"
        >
          <div ref="content" class="min-w-0" />
        </div>
      </div>
    </div>
  </section>
</template>
