<script setup lang="ts">
import type { TerminalClientMessage, TerminalInput, TerminalResult, TerminalScreen, TerminalSession, TerminalWriter } from '../../../src/terminal-protocol.ts'
import type { TerminalSubmission } from '../utils/terminal-submission.ts'
import { useClipboard, useCssVar, useDocumentVisibility, useEventListener, useIntervalFn, useMediaQuery, useOnline, useResizeObserver, useTextareaAutosize, useTextSelection, useTimeoutFn } from '@vueuse/core'
import { browserKeyEvent, CanvasRenderer } from 'ghostty-terminal-bindings/browser'
import { createSessionImeLatch } from '../utils/session-ime.ts'
import { terminalFailureCopy } from '../utils/terminal-copy.ts'
import { terminalHistoryAfterExpiry, terminalHistoryAfterLatest, terminalHistoryAfterPage } from '../utils/terminal-history-memory.ts'
import { terminalAttachmentHistoryRequest, terminalEarlierRequest } from '../utils/terminal-history-request.ts'
import { createTerminalInputChannel } from '../utils/terminal-input.ts'
import { parseTerminalFrame } from '../utils/terminal-protocol.ts'
import { terminalReadingPosition } from '../utils/terminal-reading.ts'
import { applyTerminalScreen } from '../utils/terminal-screen.ts'
import { advanceTerminalSubmission, beginTerminalSubmission, endTerminalSubmission, interruptTerminalSubmission } from '../utils/terminal-submission.ts'

const { session, cachedScreen } = defineProps<{ session: TerminalSession, cachedScreen?: TerminalScreen }>()
const emit = defineEmits<{ screen: [value: TerminalScreen] }>()
const container = useTemplateRef('container')
const terminalBackground = useCssVar('--terminal-bg', container)
const terminalForeground = useCssVar('--terminal-fg', container)
const canvas = useTemplateRef('canvas')
const input = useTemplateRef('input')
const phoneInput = useMediaQuery('(pointer: coarse)')
const draft = defineModel<string>('draft', { default: '' })
const submission = defineModel<TerminalSubmission>('submission', { default: () => ({ _tag: 'Editing' }) })
const reading = defineModel<{ snapshot?: string, offset: number, top: number } | null>('reading', { default: null })
const retainedSnapshot = defineModel<string | null>('retainedSnapshot', { default: null })
submission.value = interruptTerminalSubmission(submission.value)
const phoneDraft = useTemplateRef<HTMLTextAreaElement>('phoneDraft')
useTextareaAutosize({ element: phoneDraft, input: draft })
watch(draft, (value) => {
  if (value && submission.value._tag === 'Acknowledged')
    submission.value = { _tag: 'Editing' }
})
const sendPending = computed(() => submission.value._tag === 'Pending')
const reviewDelivery = computed(() => submission.value._tag === 'Unknown')
const phoneInputDisabled = computed(() => !writable.value || draftComposing.value || sendPending.value || reviewDelivery.value)
const phoneKeysOpen = ref(false)
watch(() => session.id, () => {
  phoneKeysOpen.value = false
})
const phoneKeys = [
  { key: 'ArrowUp', code: 'ArrowUp', shiftKey: false, label: '↑', ariaLabel: 'Arrow up' },
  { key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: false, label: '←', ariaLabel: 'Arrow left' },
  { key: 'ArrowDown', code: 'ArrowDown', shiftKey: false, label: '↓', ariaLabel: 'Arrow down' },
  { key: 'ArrowRight', code: 'ArrowRight', shiftKey: false, label: '→', ariaLabel: 'Arrow right' },
  { key: 'Tab', code: 'Tab', shiftKey: false, label: 'Tab', ariaLabel: 'Tab' },
  { key: 'Tab', code: 'Tab', shiftKey: true, label: 'Shift+Tab', ariaLabel: 'Shift+Tab' },
]
const phoneArrowKeys = computed(() => phoneKeys.filter(item => item.key.startsWith('Arrow')))
const phoneModifierKeys = computed(() => phoneKeys.filter(item => !item.key.startsWith('Arrow')))
const phoneArrowPlacement: Record<string, string> = {
  ArrowUp: 'col-start-2 row-start-1',
  ArrowLeft: 'col-start-1 row-start-2',
  ArrowDown: 'col-start-2 row-start-2',
  ArrowRight: 'col-start-3 row-start-2',
}
const submissionCopy = computed(() => sendPending.value ? 'Sending…' : submission.value._tag === 'Acknowledged' ? 'Sent to terminal' : submission.value._tag === 'Pasted' ? 'Text pasted. Press Enter to submit.' : '')
const deliveryTimeout = useTimeoutFn(() => {
  submission.value = interruptTerminalSubmission(submission.value)
}, 10000, { immediate: false })
const draftComposing = ref(false)
const visibility = useDocumentVisibility()
const online = useOnline()
let viewId = ''
const writer = shallowRef<TerminalWriter>(null)
const screen = shallowRef<TerminalScreen | undefined>(cachedScreen)
const history = shallowRef<{ snapshot?: string, total: number, offset: number, lines: string[] }>()
const historySupported = ref(false)
const historyExpired = ref(false)
const connected = ref(false)
const uncertain = ref(false)
const deliveryBlocked = ref(false)
const failure = ref('')
watch(draft, () => {
  if (failure.value === terminalFailureCopy.SizeLimit)
    failure.value = ''
})
const processState = ref(session.state)
const ended = computed(() => ['Exited', 'Interrupted'].includes(processState.value))
const earlierRequest = computed(() => terminalEarlierRequest({
  ended: ended.value,
  history: history.value,
  historySupported: historySupported.value,
  reading: reading.value,
  retainedSnapshot: retainedSnapshot.value,
  screen: screen.value,
}))
const writable = computed(() => connected.value && ['Starting', 'Running'].includes(processState.value) && !deliveryBlocked.value && writer.value?.viewId === viewId)
const canAcquireWriter = computed(() => connected.value && ['Starting', 'Running'].includes(processState.value) && !writable.value && writer.value === null)
const connectionCopy = computed(() => processState.value === 'Exited'
  ? 'Agent session exited.'
  : processState.value === 'Interrupted'
    ? 'Agent session interrupted.'
    : processState.value === 'Stopping'
      ? 'Stopping Agent.'
      : processState.value === 'Unknown'
        ? terminalFailureCopy.OwnershipUnknown
        : !online.value ? 'Offline. Your draft is saved.' : connected.value ? (writable.value ? 'Terminal connected' : 'Read-only viewer') : 'Reconnecting to the terminal.')
let renderer: CanvasRenderer | undefined
let socket: WebSocket | undefined
let disposed = false
let invalidFrame = false
let attachedOnce = false
let channel: ReturnType<typeof createTerminalInputChannel> | undefined
let lastSize = ''
let historyRequest = false
let requestedHistoryOffset: number | undefined
let historyRequestId: string | undefined
const historyLoading = ref(false)
const historyFailure = ref('')
const historyTimeout = useTimeoutFn(() => {
  historyRequest = false
  historyLoading.value = false
  historyFailure.value = 'Could not load earlier output. Retry.'
}, 8000, { immediate: false })
let touchY = 0
let touchX = 0
const ime = createSessionImeLatch()
let composing = false
let keyboardLayout: ReadonlyMap<string, string> | undefined
const selection = useTextSelection()
const { copy } = useClipboard()
const textLines = computed(() => {
  if (visibility.value !== 'visible')
    return ''
  if (history.value)
    return history.value.lines.join('\n')
  const source = screen.value
  return source?.lines.map((line, row) => line.map((cell, col) => cell.width === 0 ? '' : source.graphemes[row]?.[col] || String.fromCodePoint(cell.codepoint || 32)).join('')).join('\n') ?? ''
})
const historyLineHeight = 20
const selectionStyle = { fontFamily: 'JetBrains Mono, monospace', fontSize: '14px', lineHeight: `${historyLineHeight}px` }
const reconnect = useTimeoutFn(connect, 1500, { immediate: false })
const connectTimeout = useTimeoutFn(() => socket?.close(), 10000, { immediate: false })
const copyAcknowledged = ref(false)
const copyAcknowledgementTimeout = useTimeoutFn(() => {
  copyAcknowledged.value = false
}, 1800, { immediate: false })
const selectedTerminalText = computed(() => {
  const selected = selection.text.value
  const currentSelection = typeof window === 'undefined' ? null : window.getSelection()
  if (!selected || !currentSelection || !container.value || !currentSelection.anchorNode || !currentSelection.focusNode)
    return ''
  return container.value.contains(currentSelection.anchorNode) && container.value.contains(currentSelection.focusNode) ? selected : ''
})
const hasCopyableOutput = computed(() => Boolean(selectedTerminalText.value || textLines.value))
const copyLabel = computed(() => selectedTerminalText.value ? 'Copy selection' : 'Copy output')
const terminalMenuItems = computed(() => [
  ...(hasCopyableOutput.value ? [[{ label: copyLabel.value, icon: 'i-octicon-copy-16', class: 'min-h-11', onSelect: copyTerminalOutput }]] : []),
  ...(history.value && canAcquireWriter.value ? [[{ label: 'Use terminal', class: 'min-h-11', onSelect: () => send({ type: 'AcquireWriter' }) }]] : []),
  ...(writable.value ? [[{ label: 'Release terminal', class: 'min-h-11', onSelect: () => send({ type: 'ReleaseWriter' }) }]] : []),
])
useIntervalFn(() => {
  if (writable.value && writer.value)
    send({ type: 'RenewWriter', lease: writer.value.lease })
}, 15000)

function copyTerminalOutput() {
  const text = selectedTerminalText.value || textLines.value
  if (!text)
    return
  void copy(text).then(() => {
    copyAcknowledged.value = true
    copyAcknowledgementTimeout.start()
  }).catch(() => { failure.value = 'Could not copy terminal text. Select it and use the browser menu.' })
}

function send(message: TerminalClientMessage) {
  if (socket?.readyState !== WebSocket.OPEN)
    return false
  socket.send(JSON.stringify(message))
  return true
}

function transmitTracked(message: TerminalInput | { type: 'Resize', cols: number, rows: number }): TerminalResult<number> {
  if (!writable.value || !writer.value)
    return { _tag: 'Err', reason: 'StaleWriter' }
  const result = channel?.transmit(message) ?? { _tag: 'Err', reason: 'StaleWriter' }
  if (result?._tag === 'Err') {
    failure.value = terminalFailureCopy[result.reason]
    if (result.reason === 'DeliveryUnknown') {
      uncertain.value = true
      deliveryBlocked.value = true
      send({ type: 'ReleaseWriter' })
    }
  }
  return result
}

function transmit(message: TerminalInput | { type: 'Resize', cols: number, rows: number }) {
  return transmitTracked(message)._tag === 'Ok'
}

function submitPhone(enter: TerminalInput, state = submission.value) {
  if (!writer.value || state._tag === 'Pending' || state._tag === 'Unknown')
    return
  const pasted = state._tag === 'Pasted'
  const text = pasted ? state.text : draft.value
  const lease = writer.value.lease
  const result = transmitTracked(text && !pasted ? { type: 'Paste', text } : enter)
  const next = beginTerminalSubmission(text, enter, lease, result, pasted)
  submission.value = next
  if (next._tag === 'Pending')
    deliveryTimeout.start()
}

function resolveDelivery(clear: boolean) {
  if (clear)
    draft.value = ''
  submission.value = { _tag: 'Editing' }
  uncertain.value = false
}

function latest() {
  requestedHistoryOffset = undefined
  historyRequestId = undefined
  historyExpired.value = false
  historyRequest = false
  historyLoading.value = false
  historyTimeout.stop()
  history.value = undefined
  const next = terminalHistoryAfterLatest({ reading: reading.value, retainedSnapshot: retainedSnapshot.value })
  reading.value = next.reading
  retainedSnapshot.value = next.retainedSnapshot
  historyFailure.value = ''
  if (screen.value)
    render(screen.value)
  if (container.value)
    container.value.scrollTop = 0
}

function loadEarlier(request: ReturnType<typeof terminalEarlierRequest>) {
  if (historyRequest || historyExpired.value)
    return
  if (!request)
    return
  requestedHistoryOffset = request.offset ?? undefined
  if (request.type === 'History') {
    historyRequestId = crypto.randomUUID()
    historyRequest = send({ ...request, requestId: historyRequestId })
  }
  else {
    historyRequest = send(request)
  }
  historyLoading.value = historyRequest
  if (historyRequest)
    historyTimeout.start()
  else
    historyFailure.value = 'Could not load earlier output. Retry.'
}

function earlier() {
  loadEarlier(earlierRequest.value)
}

function showHistory(page: NonNullable<typeof history.value>) {
  const prior = history.value
  const added = prior && page.snapshot === prior.snapshot && page.offset < prior.offset && page.offset + page.lines.length >= prior.offset ? prior.offset - page.offset : 0
  const top = added ? (container.value?.scrollTop ?? 0) + added * historyLineHeight : reading.value?.top
  history.value = added && prior ? { ...page, lines: [...page.lines.slice(0, added), ...prior.lines] } : page
  retainedSnapshot.value = terminalHistoryAfterPage({ reading: reading.value, retainedSnapshot: retainedSnapshot.value }, page.snapshot).retainedSnapshot
  void nextTick(() => {
    if (container.value) {
      container.value.scrollTop = top ?? container.value.scrollHeight
      rememberScroll()
    }
  })
}

async function refreshHistory() {
  latest()
  await nextTick()
  earlier()
}

function rememberScroll() {
  if (history.value && container.value) {
    reading.value = { ...terminalReadingPosition(history.value.offset, container.value.scrollTop, historyLineHeight), snapshot: history.value.snapshot }
    if (container.value.scrollTop < 40 && history.value.offset > 0 && !historyRequest)
      earlier()
  }
}

function preventPhoneKeysAutoFocus(event: Event) {
  if (document.activeElement === phoneDraft.value)
    event.preventDefault()
}

function phoneKey(key: string, code: string, ctrlKey = false, shiftKey = false) {
  if (draftComposing.value || !writable.value || sendPending.value || reviewDelivery.value)
    return
  const encoded = browserKeyEvent(new KeyboardEvent('keydown', { key, code, ctrlKey, shiftKey }), keyboardLayout)
  if (!encoded)
    return
  latest()
  const message: TerminalInput = { type: 'Key', event: encoded }
  if (key === 'Enter') {
    submitPhone(message)
  }
  else {
    transmit(message)
  }
}

function resize() {
  if (!renderer || !container.value || !writable.value)
    return
  const metrics = renderer.getMetrics()
  const cols = Math.max(2, Math.min(500, Math.floor(container.value.clientWidth / metrics.width)))
  const rows = Math.max(2, Math.min(200, Math.floor(container.value.clientHeight / metrics.height), Math.floor(20000 / cols)))
  const size = `${cols}:${rows}`
  if (size === lastSize)
    return
  lastSize = size
  transmit({ type: 'Resize', cols, rows })
}

function render(value: TerminalScreen, dirtyRows?: ReadonlySet<number>) {
  const previousCursor = screen.value?.cursor.y
  screen.value = value
  if (!renderer || history.value || visibility.value !== 'visible')
    return
  renderer.render({
    getLine: row => value.lines[row] ?? null,
    getCursor: () => value.cursor,
    getDimensions: () => value.dimensions,
    isRowDirty: row => dirtyRows === undefined || dirtyRows.has(row) || row === previousCursor || row === value.cursor.y,
    needsFullRedraw: () => dirtyRows === undefined,
    clearDirty: () => {},
    getGraphemeString: (row, col) => value.graphemes[row]?.[col] ?? '',
  }, dirtyRows === undefined)
}

function connect() {
  if (disposed || invalidFrame || !online.value)
    return
  viewId = crypto.randomUUID()
  channel = createTerminalInputChannel({ send, viewId })
  const url = new URL(`/api/terminal/sessions/${encodeURIComponent(session.id)}/stream`, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const next = new WebSocket(url)
  socket = next
  connectTimeout.start()
  next.onopen = () => {
    if (socket === next)
      send({ type: 'Attach', protocol: 1, viewId, generation: session.generation })
  }
  next.onmessage = (event) => {
    if (socket !== next)
      return
    const decoded = parseTerminalFrame(typeof event.data === 'string' ? event.data : '')
    if (decoded._tag === 'Err') {
      failure.value = terminalFailureCopy[decoded.reason]
      invalidFrame = true
      next.close(1008, 'Invalid terminal frame')
      return
    }
    const message = decoded.value
    if (message.type === 'Attached') {
      connectTimeout.stop()
      const initialAttachment = !attachedOnce
      attachedOnce = true
      connected.value = true
      historySupported.value = message.history === true
      if (historySupported.value && reading.value && !reading.value.snapshot)
        reading.value = null
      writer.value = message.writer
      channel?.setWriter(message.writer)
      processState.value = message.session.state
      failure.value = ''
      if (!history.value && !historyRequest) {
        const request = terminalAttachmentHistoryRequest({
          ended: ended.value,
          historySupported: historySupported.value,
          reading: reading.value,
          retainedSnapshot: retainedSnapshot.value,
          screen: screen.value,
        })
        if (request)
          loadEarlier(request)
      }
      // Reconnecting viewers keep their read intent. Takeover requires Use terminal.
      if (initialAttachment && message.writer === null && ['Starting', 'Running'].includes(message.session.state))
        send({ type: 'AcquireWriter' })
    }
    else if (message.type === 'Screen' || message.type === 'Rows') {
      const result = applyTerminalScreen(screen.value, message, session.generation)
      if (result._tag === 'Err') {
        failure.value = result.reason === 'DeliveryUnknown'
          ? 'Reconnecting to the terminal.'
          : terminalFailureCopy[result.reason]
        invalidFrame = result.reason !== 'DeliveryUnknown'
        next.close(1008, 'Terminal snapshot required')
        return
      }
      render(result.value, message.type === 'Rows' ? new Set(message.rows.map(row => row.index)) : undefined)
      if (reading.value && !history.value && !historyRequest)
        earlier()
    }
    else if (message.type === 'WriterChanged') {
      const prior = writer.value?.lease
      writer.value = message.writer
      channel?.setWriter(message.writer)
      if (prior !== message.writer?.lease) {
        deliveryBlocked.value = false
        lastSize = ''
      }
      if (message.writer?.viewId === viewId) {
        resize()
        if (!phoneInput.value)
          input.value?.focus({ preventScroll: true })
      }
    }
    else if (message.type === 'InputReceipt') {
      if (channel?.receipt(message.sequence, message.lease)) {
        const next = advanceTerminalSubmission(submission.value, message.sequence, message.lease)
        submission.value = next.state
        if (next.send)
          submitPhone(next.send, next.state)
        if (next.state._tag === 'Acknowledged') {
          deliveryTimeout.stop()
          if (draft.value === next.state.text)
            draft.value = ''
        }
      }
    }
    else if (message.type === 'Process') {
      processState.value = message.state
    }
    else if (message.type === 'History' && message.generation === session.generation) {
      if (message.requestId !== historyRequestId)
        return
      historyRequestId = undefined
      historyRequest = false
      historyLoading.value = false
      historyTimeout.stop()
      if (message.result._tag === 'Expired') {
        historyExpired.value = true
        retainedSnapshot.value = terminalHistoryAfterExpiry({ reading: reading.value, retainedSnapshot: retainedSnapshot.value }).retainedSnapshot
        historyFailure.value = ended.value ? 'Earlier output expired. This session has ended.' : 'Earlier output expired. Refresh to read the retained output.'
        return
      }
      historyFailure.value = ''
      showHistory(message.result)
    }
    else if (message.type === 'Scrollback' && message.generation === session.generation) {
      if (requestedHistoryOffset !== message.offset)
        return
      requestedHistoryOffset = undefined
      historyRequest = false
      historyLoading.value = false
      historyTimeout.stop()
      historyFailure.value = ''
      showHistory({ total: message.total, offset: message.offset, lines: message.lines.map((line, row) => line.map((cell, col) => cell.width === 0 ? '' : message.graphemes[row]?.[col] || String.fromCodePoint(cell.codepoint || 32)).join('')) })
    }
    else if (message.type === 'Failure') {
      failure.value = terminalFailureCopy[message.reason]
      submission.value = interruptTerminalSubmission(submission.value)
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
    if (socket !== next)
      return
    connected.value = false
    connectTimeout.stop()
    writer.value = null
    historyRequest = false
    historyLoading.value = false
    historyTimeout.stop()
    submission.value = interruptTerminalSubmission(submission.value)
    uncertain.value ||= channel?.detach().unconfirmed ?? false
    lastSize = ''
    if (!disposed && !invalidFrame && online.value && !['Exited', 'Interrupted'].includes(processState.value))
      reconnect.start()
  }
  next.onerror = () => {
    if (!ended.value)
      failure.value = 'Reconnecting to the terminal.'
  }
}

function key(event: KeyboardEvent) {
  if (composing || event.isComposing || event.keyCode === 229) {
    event.stopPropagation()
    return
  }
  if (event.key === 'Enter' && !ime.claim(event))
    return
  // Ctrl+C reaches the CLI. Clipboard copy uses the selected terminal text.
  if ((event.ctrlKey && event.shiftKey && event.code === 'KeyC') || (event.metaKey && event.code === 'KeyC')) {
    event.preventDefault()
    if (event.type === 'keydown' && selection.text.value)
      void copy(selection.text.value).catch(() => { failure.value = 'Could not copy terminal text. Select it and use the browser menu.' })
    return
  }
  if ((event.ctrlKey && event.shiftKey && event.code === 'KeyV') || (event.metaKey && event.code === 'KeyV'))
    return
  if (!writable.value)
    return
  const encoded = browserKeyEvent(event, keyboardLayout)
  if (encoded) {
    event.preventDefault()
    latest()
    transmit({ type: 'Key', event: encoded })
  }
}

function wheel(event: WheelEvent) {
  if (!screen.value || !renderer || !canvas.value)
    return
  if (history.value)
    return
  if (screen.value.modes.mouse && !event.shiftKey) {
    event.preventDefault()
    const bounds = canvas.value.getBoundingClientRect()
    const metrics = renderer.getMetrics()
    transmit({ type: 'Mouse', action: 'wheel', button: event.deltaY < 0 ? 64 : 65, col: Math.max(1, Math.min(screen.value.dimensions.cols, Math.floor((event.clientX - bounds.left) / metrics.width) + 1)), row: Math.max(1, Math.min(screen.value.dimensions.rows, Math.floor((event.clientY - bounds.top) / metrics.height) + 1)), mods: (event.shiftKey ? 1 : 0) | (event.altKey ? 2 : 0) | (event.ctrlKey ? 4 : 0) })
    return
  }
  if (event.deltaY < 0 && screen.value.scrollbackLength > 0) {
    event.preventDefault()
    earlier()
  }
}

function commit(event: Event) {
  if ((event as InputEvent).isComposing || !input.value)
    return
  const text = input.value.value
  input.value.value = ''
  if (text)
    transmit({ type: 'Text', text })
}

function paste(event: ClipboardEvent) {
  if (!writable.value)
    return
  event.preventDefault()
  transmit({ type: 'Paste', text: event.clipboardData?.getData('text/plain') ?? '' })
}

function focus(focused: boolean) {
  if (screen.value?.modes.focus)
    transmit({ type: 'Focus', focused })
}

function mouse(event: MouseEvent, action: 'down' | 'up' | 'move') {
  if (!screen.value?.modes.mouse || event.shiftKey || !renderer || !canvas.value)
    return
  event.preventDefault()
  const bounds = canvas.value.getBoundingClientRect()
  const metrics = renderer.getMetrics()
  const col = Math.max(1, Math.min(screen.value.dimensions.cols, Math.floor((event.clientX - bounds.left) / metrics.width) + 1))
  const row = Math.max(1, Math.min(screen.value.dimensions.rows, Math.floor((event.clientY - bounds.top) / metrics.height) + 1))
  const button = action === 'move'
    ? event.buttons & 1 ? 0 : event.buttons & 4 ? 1 : event.buttons & 2 ? 2 : 3
    : event.button === 0 ? 0 : event.button === 1 ? 1 : event.button === 2 ? 2 : 3
  transmit({ type: 'Mouse', action, button, col, row, mods: (event.shiftKey ? 1 : 0) | (event.altKey ? 2 : 0) | (event.ctrlKey ? 4 : 0) })
}

useResizeObserver(container, resize)
watch(online, (value) => {
  if (!value) {
    reconnect.stop()
    socket?.close()
  }
  else if (!connected.value) {
    reconnect.stop()
    connect()
  }
})
watch(visibility, (value) => {
  if (value === 'visible' && screen.value)
    render(screen.value)
})
watch(() => session.state, (state) => {
  processState.value = state
})
watch([ended, submission], ([value]) => {
  if (value) {
    submission.value = endTerminalSubmission(submission.value)
    reconnect.stop()
    if (failure.value === 'Reconnecting to the terminal.')
      failure.value = ''
  }
}, { immediate: true })
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
useEventListener(container, 'scroll', rememberScroll, { passive: true })
useEventListener(container, 'touchstart', (event: TouchEvent) => {
  touchY = event.touches[0]?.clientY ?? 0
  touchX = event.touches[0]?.clientX ?? 0
}, { passive: true })
useEventListener(container, 'touchend', (event: TouchEvent) => {
  const touch = event.changedTouches[0]
  if (touch && !history.value && !selection.text.value && touch.clientY - touchY > 50 && Math.abs(touch.clientX - touchX) < 60)
    earlier()
}, { passive: true })
useEventListener(window, 'pagehide', () => send({ type: 'ReleaseWriter' }))

async function start() {
  const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap: () => Promise<ReadonlyMap<string, string>> } }).keyboard
  if (keyboard) {
    keyboardLayout = await keyboard.getLayoutMap().catch((cause: unknown) => {
      console.warn('Keyboard layout is unavailable. Terminal input uses browser key values.', cause instanceof Error ? cause.message : String(cause))
      return undefined
    })
  }
  await document.fonts.load('14px "JetBrains Mono"')
  if (disposed || !canvas.value)
    return
  renderer = new CanvasRenderer(canvas.value, { fontFamily: 'JetBrains Mono, monospace', fontSize: 14, cursorBlink: false, theme: { background: terminalBackground.value, foreground: terminalForeground.value } })
  if (screen.value)
    render(screen.value)
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
  connectTimeout.stop()
  deliveryTimeout.stop()
  historyTimeout.stop()
  copyAcknowledgementTimeout.stop()
  submission.value = interruptTerminalSubmission(submission.value)
  if (screen.value)
    emit('screen', screen.value)
  send({ type: 'ReleaseWriter' })
  socket?.close()
})
</script>

<template>
  <div class="flex min-h-0 flex-col">
    <div class="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-2 border-b border-default px-3 text-sm text-muted">
      <span role="status" class="min-w-0 flex-1 break-words">{{ history ? 'Earlier output' : connectionCopy }}</span>
      <UTooltip v-if="earlierRequest" text="Earlier output">
        <UButton icon="i-octicon-history-16" aria-label="Earlier output" color="neutral" variant="ghost" class="min-h-11 min-w-11 justify-center" :loading="historyLoading" :disabled="!connected || historyExpired || history?.offset === 0" @click="earlier" />
      </UTooltip>
      <UButton v-if="history || historyExpired" icon="i-octicon-arrow-down-16" color="neutral" variant="outline" class="min-h-11" @click="latest">
        Latest
      </UButton>
      <UButton v-if="canAcquireWriter && !history" size="xs" variant="ghost" class="min-h-11" @click="send({ type: 'AcquireWriter' })">
        Use terminal
      </UButton>
      <UDropdownMenu v-if="writable || hasCopyableOutput || (history && canAcquireWriter)" :items="terminalMenuItems">
        <UButton icon="i-octicon-kebab-horizontal-16" aria-label="Terminal controls" size="sm" variant="ghost" class="min-h-11 min-w-11 justify-center" />
      </UDropdownMenu>
    </div>
    <p v-if="copyAcknowledged" role="status" class="shrink-0 px-3 py-1 text-xs text-muted">
      Copied
    </p>
    <p v-if="uncertain && !reviewDelivery" role="alert" class="shrink-0 px-3 py-2 text-sm text-warning">
      Input delivery is unknown. Check the terminal before sending again.
    </p>
    <p v-if="failure" role="alert" class="shrink-0 px-3 py-1 text-xs text-error">
      {{ failure }}
    </p>
    <div v-if="historyFailure" role="alert" class="shrink-0 px-3 py-2 text-sm text-error">
      <p>{{ historyFailure }}</p>
      <UButton v-if="historyExpired && !ended" color="neutral" variant="outline" class="mt-2 min-h-11" :disabled="!connected" @click="refreshHistory">
        Refresh earlier output
      </UButton>
    </div>
    <p v-if="history && !historySupported" class="shrink-0 px-3 py-1 text-xs text-muted">
      This session uses live history. New output can move older lines.
    </p>
    <div ref="container" class="terminal-viewport relative min-h-0 flex-1 overflow-auto overscroll-contain" :tabindex="history ? 0 : undefined" :aria-label="history ? 'Earlier terminal output' : undefined" @click="!phoneInput && !history && input?.focus({ preventScroll: true })">
      <p v-if="ended && !screen && !history" class="p-4 text-sm text-muted">
        This terminal has ended. Its work remains in the project.
      </p>
      <canvas v-show="!history" ref="canvas" aria-hidden="true" class="block" @mousedown="mouse($event, 'down')" @mouseup="mouse($event, 'up')" @mousemove="mouse($event, 'move')" />
      <textarea ref="input" aria-label="Agent terminal" :readonly="!writable || phoneInput" :tabindex="phoneInput ? -1 : 0" :aria-hidden="phoneInput" autocapitalize="off" autocomplete="off" autocorrect="off" :spellcheck="false" class="absolute top-0 left-0 size-px resize-none border-0 p-0 text-base opacity-0 outline-none" @focus="focus(true)" @blur="focus(false)" />
      <pre :style="selectionStyle" class="terminal-selection m-0 select-text whitespace-pre" :class="history ? 'text-default' : 'absolute top-0 left-0 text-transparent'" aria-label="Agent terminal output" @mousedown="!history && mouse($event, 'down')" @mouseup="!history && mouse($event, 'up')" @mousemove="!history && mouse($event, 'move')">{{ textLines }}</pre>
    </div>
    <div v-if="phoneInput && (!ended || draft)" class="terminal-composer shrink-0 space-y-2 border-t border-default bg-default p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <div v-if="reviewDelivery" role="alert" class="space-y-2 text-sm">
        <p class="text-warning">
          Input delivery is unknown. Check the terminal before sending again.
        </p>
        <div class="flex gap-2">
          <UButton color="neutral" variant="outline" @click="resolveDelivery(true)">
            Already sent
          </UButton>
          <UButton color="neutral" variant="outline" @click="resolveDelivery(false)">
            Not sent
          </UButton>
        </div>
      </div>
      <textarea ref="phoneDraft" v-model="draft" aria-label="Agent terminal" placeholder="Message the Agent…" :readonly="sendPending || reviewDelivery || submission._tag === 'Pasted'" rows="2" class="block max-h-32 min-h-11 w-full resize-y rounded border border-default bg-default p-2 text-base outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" @compositionstart="draftComposing = true" @compositionend="draftComposing = false" @focus="focus(true)" @blur="focus(false)" />
      <p v-if="submissionCopy" role="status" class="text-sm text-muted">
        {{ submissionCopy }}
      </p>
      <div class="flex gap-2">
        <UPopover v-model:open="phoneKeysOpen" :reference="phoneDraft" :content="{ side: 'top', align: 'start', onOpenAutoFocus: preventPhoneKeysAutoFocus }">
          <UButton color="neutral" variant="outline" class="min-h-11 min-w-11 justify-center" :disabled="phoneInputDisabled" aria-label="Keys" @pointerdown.prevent>
            Keys
          </UButton>
          <template #content>
            <div role="group" aria-label="Terminal keys" class="space-y-1 p-2">
              <div class="grid grid-cols-3 gap-1">
                <UButton v-for="phoneKeyItem in phoneArrowKeys" :key="phoneKeyItem.ariaLabel" color="neutral" variant="outline" class="min-h-11 min-w-11 justify-center" :class="phoneArrowPlacement[phoneKeyItem.key]" :aria-label="phoneKeyItem.ariaLabel" :disabled="phoneInputDisabled" @pointerdown.prevent @click="phoneKey(phoneKeyItem.key, phoneKeyItem.code, false, phoneKeyItem.shiftKey)">
                  {{ phoneKeyItem.label }}
                </UButton>
              </div>
              <div class="flex gap-1">
                <UButton v-for="phoneKeyItem in phoneModifierKeys" :key="phoneKeyItem.ariaLabel" color="neutral" variant="outline" class="min-h-11 flex-1 justify-center" :aria-label="phoneKeyItem.ariaLabel" :disabled="phoneInputDisabled" @pointerdown.prevent @click="phoneKey(phoneKeyItem.key, phoneKeyItem.code, false, phoneKeyItem.shiftKey)">
                  {{ phoneKeyItem.label }}
                </UButton>
              </div>
            </div>
          </template>
        </UPopover>
        <UButton color="neutral" variant="outline" class="min-h-11" :disabled="!writable || draftComposing || sendPending || reviewDelivery" @pointerdown.prevent @click="phoneKey('Escape', 'Escape')">
          Esc
        </UButton>
        <UButton color="neutral" variant="outline" class="min-h-11" :disabled="!writable || draftComposing || sendPending || reviewDelivery" @pointerdown.prevent @click="phoneKey('c', 'KeyC', true)">
          Ctrl+C
        </UButton>
        <UButton class="ml-auto min-h-11 min-w-16 justify-center" :disabled="!writable || draftComposing || sendPending || reviewDelivery" @pointerdown.prevent @click="phoneKey('Enter', 'Enter')">
          {{ sendPending ? 'Sending…' : submission._tag === 'Pasted' || !draft ? 'Enter' : 'Send' }}
        </UButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-viewport {
  background: var(--terminal-bg);
}

@media (max-height: 500px) and (pointer: coarse) {
  .terminal-composer { padding-top: 0.25rem; }
  .terminal-composer textarea { height: 44px; }
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
