import type { HogwildStatus } from '../utils/hogwild-status.ts'
import { useBrowserLocation, useMounted, useWebSocket } from '@vueuse/core'
import {
  appendHogwildSample,
  emptyHogwildHistory,
  hogwildLiveUrl,
  parseHogwildStatus,
} from '../utils/hogwild-status.ts'

export type HogwildConnection
  = | { _tag: 'NotOnHogwild' }
    | { _tag: 'Connecting' }
    | { _tag: 'Connected', status: HogwildStatus }
    | { _tag: 'Unavailable', reason: string }

export function useHogwildStatus() {
  const location = useBrowserLocation()
  const mounted = useMounted()
  const liveUrl = computed(() => mounted.value
    ? hogwildLiveUrl(location.value.hostname ?? '', location.value.protocol ?? '')
    : undefined)
  const connection = shallowRef<HogwildConnection>({ _tag: 'NotOnHogwild' })
  const history = shallowRef(emptyHogwildHistory())

  function unavailable(reason: string): void {
    connection.value = { _tag: 'Unavailable', reason }
    history.value = emptyHogwildHistory()
  }

  const { status } = useWebSocket<string>(liveUrl, {
    immediate: false,
    autoReconnect: {
      delay: 1_500,
      retries: () => liveUrl.value !== undefined,
    },
    onConnected: () => {
      connection.value = { _tag: 'Connecting' }
    },
    onDisconnected: () => {
      unavailable('Hogwild status disconnected. Reconnecting.')
    },
    onError: () => {
      unavailable('Hogwild status could not connect. Retrying.')
    },
    onMessage: (_socket, event) => {
      if (typeof event.data !== 'string') {
        unavailable('Hogwild sent an unsupported status message.')
        return
      }
      const parsed = parseHogwildStatus(event.data)
      if (parsed._tag === 'Err') {
        unavailable(parsed.reason)
        return
      }
      history.value = appendHogwildSample(history.value, parsed.value)
      connection.value = { _tag: 'Connected', status: parsed.value }
    },
  })

  watch(liveUrl, (value) => {
    connection.value = value === undefined
      ? { _tag: 'NotOnHogwild' }
      : { _tag: 'Connecting' }
    history.value = emptyHogwildHistory()
  })

  return { connection, history, status }
}
