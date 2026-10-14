<script setup lang="ts">
import type {
  TerminalClientMessage,
  TerminalInput,
  TerminalScreen,
  TerminalSession,
  TerminalWriter,
} from '../../../src/terminal-protocol.ts'
import {
  useClipboard,
  useCssVar,
  useDocumentVisibility,
  useEventListener,
  useIntervalFn,
  useResizeObserver,
  useTextSelection,
  useTimeoutFn,
} from '@vueuse/core'
import { browserKeyEvent, CanvasRenderer } from 'ghostty-terminal-bindings/browser'
import { createSessionImeLatch } from '../utils/session-ime.ts'
import { terminalFailureCopy } from '../utils/terminal-copy.ts'
import { createTerminalInputChannel } from '../utils/terminal-input.ts'
import { parseTerminalFrame } from '../utils/terminal-protocol.ts'
import { applyTerminalScreen } from '../utils/terminal-screen.ts'

const { session } = defineProps<{ session: TerminalSession }>()
const container = useTemplateRef('container')
const terminalBackground = useCssVar('--terminal-bg', container)
const terminalForeground = useCssVar('--terminal-fg', container)
const canvas = useTemplateRef('canvas')
const input = useTemplateRef('input')
const visibility = useDocumentVisibility()
let viewId = ''
const writer = shallowRef<TerminalWriter>(null)
const screen = shallowRef<TerminalScreen>()
const history = shallowRef<{ total: number; offset: number; lines: TerminalScreen['lines']; graphemes: string[][] }>()
const connected = ref(false)
const uncertain = ref(false)
const deliveryBlocked = ref(false)
const failure = ref('')
const processState = ref(session.state)
const ended = computed(() => ['Exited', 'Interrupted'].includes(processState.value))
const writable = computed(
  () =>
    connected.value &&
    ['Starting', 'Running'].includes(processState.value) &&
    !deliveryBlocked.value &&
    writer.value?.viewId === viewId,
)
const connectionCopy = computed(() =>
  processState.value === 'Exited'
    ? 'Agent session exited.'
    : processState.value === 'Interrupted'
      ? 'Agent session interrupted.'
      : processState.value === 'Stopping'
        ? 'Stopping Agent.'
        : processState.value === 'Unknown'
          ? terminalFailureCopy.OwnershipUnknown
          : connected.value
            ? writable.value
              ? 'Terminal connected'
              : 'Read-only viewer'
            : 'Reconnecting to the terminal.',
)
let renderer: CanvasRenderer | undefined
let socket: WebSocket | undefined
let disposed = false
let invalidFrame = false
let attachedOnce = false
let channel: ReturnType<typeof createTerminalInputChannel> | undefined
let lastSize = ''
let historyRequest = false
const ime = createSessionImeLatch()
let composing = false
let keyboardLayout: ReadonlyMap<string, string> | undefined
const selection = useTextSelection()
const { copy } = useClipboard()
const textLines = computed(() => {
  if (visibility.value !== 'visible') return ''
  const source = history.value ?? screen.value
  return (
    source?.lines
      .map((line, row) =>
        line
          .map((cell, col) =>
            cell.width === 0 ? '' : source.graphemes[row]?.[col] || String.fromCodePoint(cell.codepoint || 32),
          )
          .join(''),
      )
      .join('\n') ?? ''
  )
})
const selectionStyle = computed(() => {
  const metrics = renderer?.getMetrics()
  return { fontFamily: 'JetBrains Mono, monospace', fontSize: '14px', lineHeight: `${metrics?.height ?? 20}px` }
})
const reconnect = useTimeoutFn(connect, 1500, { immediate: false })
useIntervalFn(() => {
  if (writable.value && writer.value) send({ type: 'RenewWriter', lease: writer.value.lease })
}, 15000)

function send(message: TerminalClientMessage) {
  if (socket?.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(message))
  return true
}

function transmit(message: TerminalInput | { type: 'Resize'; cols: number; rows: number }) {
  if (!writable.value || !writer.value) return
  const result = channel?.transmit(message)
  if (result?._tag === 'Err') {
    failure.value = terminalFailureCopy[result.reason]
    if (result.reason === 'DeliveryUnknown') {
      uncertain.value = true
      deliveryBlocked.value = true
      send({ type: 'ReleaseWriter' })
    }
  }
}

function resize() {
  if (!renderer || !container.value || !writable.value) return
  const metrics = renderer.getMetrics()
  const cols = Math.max(2, Math.min(500, Math.floor(container.value.clientWidth / metrics.width)))
  const rows = Math.max(
    2,
    Math.min(200, Math.floor(container.value.clientHeight / metrics.height), Math.floor(20000 / cols)),
  )
  const size = `${cols}:${rows}`
  if (size === lastSize) return
  lastSize = size
  transmit({ type: 'Resize', cols, rows })
}

function render(value: TerminalScreen, dirtyRows?: ReadonlySet<number>) {
  const previousCursor = screen.value?.cursor.y
  screen.value = value
  if (!renderer || history.value || visibility.value !== 'visible') return
  renderer.render(
    {
      getLine: (row) => value.lines[row] ?? null,
      getCursor: () => value.cursor,
      getDimensions: () => value.dimensions,
      isRowDirty: (row) =>
        dirtyRows === undefined || dirtyRows.has(row) || row === previousCursor || row === value.cursor.y,
      needsFullRedraw: () => dirtyRows === undefined,
      clearDirty: () => {},
      getGraphemeString: (row, col) => value.graphemes[row]?.[col] ?? '',
    },
    dirtyRows === undefined,
  )
}

function connect() {
  if (disposed || invalidFrame || ['Exited', 'Interrupted'].includes(processState.value)) return
  viewId = crypto.randomUUID()
  channel = createTerminalInputChannel({ send, viewId })
  const url = new URL(`/api/terminal/sessions/${encodeURIComponent(session.id)}/stream`, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const next = new WebSocket(url)
  socket = next
  next.onopen = () => {
    if (socket === next) send({ type: 'Attach', protocol: 1, viewId, generation: session.generation })
  }
  next.onmessage = (event) => {
    if (socket !== next) return
    const decoded = parseTerminalFrame(typeof event.data === 'string' ? event.data : '')
    if (decoded._tag === 'Err') {
      failure.value = terminalFailureCopy[decoded.reason]
      invalidFrame = true
      next.close(1008, 'Invalid terminal frame')
      return
    }
    const message = decoded.value
    if (message.type === 'Attached') {
      const initialAttachment = !attachedOnce
      attachedOnce = true
      connected.value = true
      writer.value = message.writer
      channel?.setWriter(message.writer)
      processState.value = message.session.state
      failure.value = ''
      // Reconnecting viewers keep their read intent. Takeover requires Use terminal.
      if (initialAttachment && message.writer === null && ['Starting', 'Running'].includes(message.session.state))
        send({ type: 'AcquireWriter' })
    } else if (message.type === 'Screen' || message.type === 'Rows') {
      const result = applyTerminalScreen(screen.value, message, session.generation)
      if (result._tag === 'Err') {
        failure.value =
          result.reason === 'DeliveryUnknown' ? 'Reconnecting to the terminal.' : terminalFailureCopy[result.reason]
        invalidFrame = result.reason !== 'DeliveryUnknown'
        next.close(1008, 'Terminal snapshot required')
        return
      }
      render(result.value, message.type === 'Rows' ? new Set(message.rows.map((row) => row.index)) : undefined)
    } else if (message.type === 'WriterChanged') {
      const prior = writer.value?.lease
      writer.value = message.writer
      channel?.setWriter(message.writer)
      if (prior !== message.writer?.lease) {
        deliveryBlocked.value = false
        lastSize = ''
      }
      if (message.writer?.viewId === viewId) {
        resize()
        input.value?.focus({ preventScroll: true })
      }
    } else if (message.type === 'InputReceipt') {
      channel?.receipt(message.sequence, message.lease)
    } else if (message.type === 'Process') {
      processState.value = message.state
    } else if (message.type === 'Scrollback' && message.generation === session.generation) {
      historyRequest = false
      history.value = message
      if (renderer && screen.value) {
        const cols = screen.value.dimensions.cols
        renderer.resize(cols, Math.max(2, message.lines.length))
        renderer.render(
          {
            getLine: (row) => message.lines[row] ?? null,
            getCursor: () => ({ x: 0, y: 0, visible: false }),
            getDimensions: () => ({ cols, rows: Math.max(2, message.lines.length) }),
            isRowDirty: () => true,
            clearDirty: () => {},
            getGraphemeString: (row, col) => message.graphemes[row]?.[col] ?? '',
          },
          true,
        )
      }
    } else if (message.type === 'Failure') {
      failure.value = terminalFailureCopy[message.reason]
      if (message.reason === 'DeliveryUnknown') {
        uncertain.value = true
        deliveryBlocked.value = true
        channel?.detach()
        send({ type: 'ReleaseWriter' })
      }
      if (message.reason === 'StaleWriter' || message.reason === 'WriterBusy') {
        writer.value = null
        channel?.setWriter(null)
      }
    }
  }
  next.onclose = () => {
    if (socket !== next) return
    connected.value = false
    writer.value = null
    historyRequest = false
    uncertain.value ||= channel?.detach().unconfirmed ?? false
    lastSize = ''
    if (!disposed && !invalidFrame && !['Exited', 'Interrupted'].includes(processState.value)) reconnect.start()
  }
  next.onerror = () => {
    if (!ended.value) failure.value = 'Reconnecting to the terminal.'
  }
}

function key(event: KeyboardEvent) {
  if (composing || event.isComposing || event.keyCode === 229) {
    event.stopPropagation()
    return
  }
  if (event.key === 'Enter' && !ime.claim(event)) return
  // Ctrl+C reaches the CLI. Clipboard copy uses the selected terminal text.
  if ((event.ctrlKey && event.shiftKey && event.code === 'KeyC') || (event.metaKey && event.code === 'KeyC')) {
    event.preventDefault()
    if (event.type === 'keydown' && selection.text.value)
      void copy(selection.text.value).catch(() => {
        failure.value = 'Could not copy terminal text. Select it and use the browser menu.'
      })
    return
  }
  if ((event.ctrlKey && event.shiftKey && event.code === 'KeyV') || (event.metaKey && event.code === 'KeyV')) return
  if (!writable.value) return
  const encoded = browserKeyEvent(event, keyboardLayout)
  if (encoded) {
    event.preventDefault()
    history.value = undefined
    if (screen.value) render(screen.value)
    transmit({ type: 'Key', event: encoded })
  }
}

function wheel(event: WheelEvent) {
  if (!screen.value || !renderer || !canvas.value) return
  if (screen.value.modes.mouse && !event.shiftKey) {
    event.preventDefault()
    const bounds = canvas.value.getBoundingClientRect()
    const metrics = renderer.getMetrics()
    transmit({
      type: 'Mouse',
      action: 'wheel',
      button: event.deltaY < 0 ? 64 : 65,
      col: Math.max(
        1,
        Math.min(screen.value.dimensions.cols, Math.floor((event.clientX - bounds.left) / metrics.width) + 1),
      ),
      row: Math.max(
        1,
        Math.min(screen.value.dimensions.rows, Math.floor((event.clientY - bounds.top) / metrics.height) + 1),
      ),
      mods: (event.shiftKey ? 1 : 0) | (event.altKey ? 2 : 0) | (event.ctrlKey ? 4 : 0),
    })
    return
  }
  if (historyRequest || screen.value.scrollbackLength === 0) return
  if (history.value && event.deltaY > 0 && history.value.offset + history.value.lines.length >= history.value.total) {
    history.value = undefined
    render(screen.value)
    return
  }
  const offset = history.value
    ? Math.max(0, Math.min(history.value.total - 1, history.value.offset + (event.deltaY < 0 ? -20 : 20)))
    : Math.max(0, screen.value.scrollbackLength - 100)
  historyRequest = send({ type: 'Scrollback', offset, limit: 100 })
}

function commit(event: Event) {
  if ((event as InputEvent).isComposing || !input.value) return
  const text = input.value.value
  input.value.value = ''
  if (text) transmit({ type: 'Text', text })
}

function paste(event: ClipboardEvent) {
  if (!writable.value) return
  event.preventDefault()
  transmit({ type: 'Paste', text: event.clipboardData?.getData('text/plain') ?? '' })
}

function focus(focused: boolean) {
  if (screen.value?.modes.focus) transmit({ type: 'Focus', focused })
}

function mouse(event: MouseEvent, action: 'down' | 'up' | 'move') {
  if (!screen.value?.modes.mouse || event.shiftKey || !renderer || !canvas.value) return
  event.preventDefault()
  const bounds = canvas.value.getBoundingClientRect()
  const metrics = renderer.getMetrics()
  const col = Math.max(
    1,
    Math.min(screen.value.dimensions.cols, Math.floor((event.clientX - bounds.left) / metrics.width) + 1),
  )
  const row = Math.max(
    1,
    Math.min(screen.value.dimensions.rows, Math.floor((event.clientY - bounds.top) / metrics.height) + 1),
  )
  const button =
    action === 'move'
      ? event.buttons & 1
        ? 0
        : event.buttons & 4
          ? 1
          : event.buttons & 2
            ? 2
            : 3
      : event.button === 0
        ? 0
        : event.button === 1
          ? 1
          : event.button === 2
            ? 2
            : 3
  transmit({
    type: 'Mouse',
    action,
    button,
    col,
    row,
    mods: (event.shiftKey ? 1 : 0) | (event.altKey ? 2 : 0) | (event.ctrlKey ? 4 : 0),
  })
}

useResizeObserver(container, resize)
watch(visibility, (value) => {
  if (value === 'visible' && screen.value) render(screen.value)
})
watch(
  () => session.state,
  (state) => {
    processState.value = state
  },
)
watch(ended, (value) => {
  if (value) {
    reconnect.stop()
    if (failure.value === 'Reconnecting to the terminal.') failure.value = ''
  }
})
useEventListener(input, 'keydown', key)
useEventListener(input, 'keyup', key)
useEventListener(input, 'input', commit)
useEventListener(input, 'compositionstart', () => {
  composing = true
  ime.start()
})
useEventListener(input, 'compositionend', (event: CompositionEvent) => {
  composing = false
  ime.end(event.data)
  commit(event)
})
useEventListener(input, 'paste', paste)
useEventListener(container, 'wheel', wheel, { passive: false })
useEventListener(window, 'pagehide', () => send({ type: 'ReleaseWriter' }))

async function start() {
  const keyboard = (
    navigator as Navigator & { keyboard?: { getLayoutMap: () => Promise<ReadonlyMap<string, string>> } }
  ).keyboard
  if (keyboard) {
    keyboardLayout = await keyboard.getLayoutMap().catch((cause: unknown) => {
      console.warn(
        'Keyboard layout is unavailable. Terminal input uses browser key values.',
        cause instanceof Error ? cause.message : String(cause),
      )
      return undefined
    })
  }
  await document.fonts.load('14px "JetBrains Mono"')
  if (disposed || !canvas.value) return
  renderer = new CanvasRenderer(canvas.value, {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 14,
    cursorBlink: false,
    theme: { background: terminalBackground.value, foreground: terminalForeground.value },
  })
  connect()
}

onMounted(() => {
  void start().catch(() => {
    failure.value = 'Could not load projects or sessions. Reload.'
  })
})

onScopeDispose(() => {
  disposed = true
  ime.reset()
  reconnect.stop()
  send({ type: 'ReleaseWriter' })
  socket?.close()
})
</script>

<template>
  <div class="flex min-h-0 flex-col">
    <div class="flex shrink-0 items-center justify-between border-b border-default px-3 py-1 text-xs text-muted">
      <span role="status">{{ connectionCopy }}</span>
      <UButton
        v-if="connected && ['Starting', 'Running'].includes(processState) && !writable && writer === null"
        size="xs"
        variant="ghost"
        @click="send({ type: 'AcquireWriter' })"
      >
        Use terminal
      </UButton>
      <UButton v-if="writable" size="xs" variant="ghost" @click="send({ type: 'ReleaseWriter' })">
        Release terminal
      </UButton>
    </div>
    <p v-if="uncertain" role="alert" class="shrink-0 px-3 py-2 text-xs text-warning">
      Input delivery is unknown. Check the terminal before sending again.
    </p>
    <p v-if="failure" role="alert" class="shrink-0 px-3 py-1 text-xs text-error">
      {{ failure }}
    </p>
    <div
      ref="container"
      class="terminal-viewport relative min-h-0 flex-1 overflow-auto"
      @click="input?.focus({ preventScroll: true })"
    >
      <canvas
        ref="canvas"
        aria-hidden="true"
        class="block"
        @mousedown="mouse($event, 'down')"
        @mouseup="mouse($event, 'up')"
        @mousemove="mouse($event, 'move')"
      />
      <textarea
        ref="input"
        aria-label="Agent terminal"
        :readonly="!writable"
        autocapitalize="off"
        autocomplete="off"
        autocorrect="off"
        :spellcheck="false"
        class="absolute top-0 left-0 size-px resize-none border-0 p-0 opacity-0 outline-none"
        @focus="focus(true)"
        @blur="focus(false)"
      />
      <pre
        :style="selectionStyle"
        class="terminal-selection absolute top-0 left-0 m-0 select-text whitespace-pre text-transparent"
        aria-label="Agent terminal output"
        @mousedown="mouse($event, 'down')"
        @mouseup="mouse($event, 'up')"
        @mousemove="mouse($event, 'move')"
        >{{ textLines }}</pre>
    </div>
  </div>
</template>

<style scoped>
.terminal-viewport {
  background: var(--terminal-bg);
}

.terminal-viewport:focus-within {
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}

.terminal-selection::selection {
  background: var(--terminal-selection);
  color: var(--terminal-selection-text);
}
</style>
