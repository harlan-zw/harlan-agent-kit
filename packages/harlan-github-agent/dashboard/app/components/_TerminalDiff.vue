<script setup lang="ts">
import type { VirtualizedFileDiff, Virtualizer } from '@pierre/diffs'
import type { TerminalDiffContent, TerminalDiffError, TerminalDiffInventory, TerminalDiffSource } from '../utils/terminal-diff'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { parseTerminalDiffContent, parseTerminalDiffInventory, prepareTerminalDiffContent, terminalDiffParseOptions } from '../utils/terminal-diff'

const { sessionId, comparison } = defineProps<{ sessionId: string, comparison?: { base: string, head: string } }>()
const emit = defineEmits<{ close: [] }>()
type InventoryState = { _tag: 'Loading' } | { _tag: 'Ready', value: TerminalDiffInventory } | { _tag: 'Failure', error: TerminalDiffError }
type FileState = { _tag: 'Idle' } | { _tag: 'Loading' } | { _tag: 'Ready', value: TerminalDiffContent } | { _tag: 'Failure', error: TerminalDiffError }
const inventory = shallowRef<InventoryState>({ _tag: 'Loading' })
const file = shallowRef<FileState>({ _tag: 'Idle' })
const source = shallowRef<TerminalDiffSource>({ _tag: 'Working' })
const selectedPath = ref('')
const style = ref<'split' | 'unified'>('split')
const scroll = useTemplateRef<HTMLElement>('scroll')
const content = useTemplateRef<HTMLElement>('content')
const colorMode = useColorMode()
let listRequest: AbortController | undefined
let fileRequest: AbortController | undefined
let renderer: VirtualizedFileDiff | undefined
let virtualizer: Virtualizer | undefined
let renderEpoch = 0
let mounted = false

const files = computed(() => inventory.value._tag === 'Ready' ? inventory.value.value.files : [])
const loading = computed(() => inventory.value._tag === 'Loading' || file.value._tag === 'Loading')
const error = computed(() => {
  const reason = inventory.value._tag === 'Failure' ? inventory.value.error : file.value._tag === 'Failure' ? file.value.error : undefined
  if (!reason)
    return ''
  if (reason === 'Changed')
    return 'The file changed. Reload.'
  if (reason === 'Binary')
    return 'Binary file.'
  if (reason === 'TooLarge')
    return 'File exceeds the diff limit.'
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
  return `/api/terminal/sessions/${encodeURIComponent(sessionId)}/diff?${new URLSearchParams(query)}`
}
async function read(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok)
    throw new Error(`Diff request returned ${response.status}`)
  return response.json()
}
async function renderFile(value: TerminalDiffContent): Promise<void> {
  cleanRenderer()
  const epoch = renderEpoch
  // Load the diff engine only when a selected file needs rendering.
  const library = await import('@pierre/diffs')
  await nextTick()
  if (!mounted || epoch !== renderEpoch || !scroll.value || !content.value)
    return
  virtualizer = new library.Virtualizer({ overscrollSize: 300, intersectionObserverMargin: 300 })
  virtualizer.setup(scroll.value, content.value)
  renderer = new library.VirtualizedFileDiff({ diffStyle: style.value, themeType: colorMode.value === 'dark' ? 'dark' : 'light', disableFileHeader: true, lineDiffType: 'none', tokenizeMaxLength: 0, tokenizeMaxLineLength: 0, disableErrorHandling: true }, virtualizer)
  const oldFile = { name: value.path, contents: value.oldText, lang: 'text' as const, cacheKey: `${value.generation}:old` }
  const newFile = { name: value.path, contents: value.newText, lang: 'text' as const, cacheKey: `${value.generation}:new` }
  let diff
  try {
    diff = library.parseDiffFromFile(oldFile, newFile, terminalDiffParseOptions)
  }
  catch (cause) {
    console.error('File exceeds the diff limit.', cause)
    cleanRenderer()
    file.value = { _tag: 'Failure', error: 'TooLarge' }
    return
  }
  renderer.render({ fileContainer: content.value, fileDiff: diff })
}
async function select(path: string): Promise<void> {
  if (inventory.value._tag !== 'Ready')
    return
  const snapshot = inventory.value.value.id
  fileRequest?.abort()
  cleanRenderer()
  selectedPath.value = path
  file.value = { _tag: 'Loading' }
  const request = new AbortController()
  fileRequest = request
  try {
    const result = parseTerminalDiffContent(await read(endpoint({ snapshot, path }), request.signal), path)
    if (request.signal.aborted || !mounted)
      return
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
    if (scroll.value)
      scroll.value.scrollTop = 0
    await renderFile(result.value)
  }
  catch (cause) {
    // Closing or changing the selection intentionally cancels its request.
    if (request.signal.aborted || !mounted)
      return
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
    const result = parseTerminalDiffInventory(await read(endpoint(query), request.signal))
    if (request.signal.aborted || !mounted)
      return
    if (result._tag === 'Err') {
      inventory.value = { _tag: 'Failure', error: result.error }
      return
    }
    inventory.value = { _tag: 'Ready', value: result.value }
    if (result.value.files[0])
      await select(result.value.files[0].path)
  }
  catch (cause) {
    // Closing or changing the source intentionally cancels its request.
    if (request.signal.aborted || !mounted)
      return
    console.error('Could not load the diff.', cause)
    inventory.value = { _tag: 'Failure', error: 'Unavailable' }
  }
}
watch(() => [comparison?.base, comparison?.head] as const, ([base, head]) => {
  source.value = base && head ? { _tag: 'Comparison', base, head } : { _tag: 'Working' }
}, { immediate: true })
watch([() => sessionId, source], () => {
  if (mounted)
    void reload()
})
watch([style, () => colorMode.value], () => {
  if (file.value._tag === 'Ready') {
    const pending = renderFile(file.value.value)
    const epoch = renderEpoch
    void pending.catch((cause: unknown) => {
      if (!mounted || epoch !== renderEpoch)
        return
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
    <header class="flex shrink-0 flex-wrap items-center gap-1 border-b border-default px-2 py-1 [&_button]:min-h-11 md:[&_button]:min-h-8">
      <strong class="mr-2 text-sm font-semibold">Diff</strong>
      <UButton label="Working tree" size="sm" color="neutral" :variant="source._tag === 'Working' ? 'soft' : 'ghost'" :aria-pressed="source._tag === 'Working'" @click="source = { _tag: 'Working' }" />
      <UButton label="Staged" size="sm" color="neutral" :variant="source._tag === 'Staged' ? 'soft' : 'ghost'" :aria-pressed="source._tag === 'Staged'" @click="source = { _tag: 'Staged' }" />
      <div class="ml-auto flex items-center gap-1">
        <UButton label="Split" size="sm" color="neutral" :variant="style === 'split' ? 'soft' : 'ghost'" :aria-pressed="style === 'split'" @click="style = 'split'" />
        <UButton label="Unified" size="sm" color="neutral" :variant="style === 'unified' ? 'soft' : 'ghost'" :aria-pressed="style === 'unified'" @click="style = 'unified'" />
        <UButton label="Reload" size="sm" color="neutral" variant="ghost" @click="reload" />
        <UButton icon="i-octicon-x-16" aria-label="Close diff" size="sm" color="neutral" variant="ghost" @click="emit('close')" />
      </div>
    </header>
    <div class="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav class="max-h-36 shrink-0 overflow-auto border-b border-default md:max-h-none md:w-48 md:border-r md:border-b-0" aria-label="Files">
        <button v-for="item in files" :key="item.path" type="button" class="flex min-h-11 w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-muted" :class="selectedPath === item.path ? 'bg-elevated' : ''" :aria-current="selectedPath === item.path ? 'true' : undefined" :title="item.path" @click="select(item.path)">
          <span class="w-6 shrink-0 font-mono text-xs text-muted">{{ item.status }}</span>
          <span class="min-w-0 whitespace-pre-wrap break-all font-mono">{{ item.path }}</span>
        </button>
      </nav>
      <div class="relative min-h-0 min-w-0 flex-1">
        <div v-if="loading" class="absolute inset-0 z-10 grid place-items-center bg-default/80" role="status" aria-label="Diff">
          <UIcon name="i-octicon-sync-16" class="size-5 animate-spin text-muted motion-reduce:animate-none" aria-hidden="true" />
        </div>
        <p v-else-if="error" class="p-4 text-sm" role="alert">
          {{ error }}
        </p>
        <p v-else-if="inventory._tag === 'Ready' && files.length === 0" class="p-4 text-sm text-muted">
          No changed files.
        </p>
        <div v-show="!error && files.length > 0" ref="scroll" class="h-full min-h-0 overflow-auto" style="--diffs-font-family: var(--font-mono); --diffs-font-size: 14px;">
          <div ref="content" class="min-w-0" />
        </div>
      </div>
    </div>
  </section>
</template>
