import type { Component } from 'vue'
import { defineComponent, h, onMounted, onScopeDispose, ref, shallowRef } from 'vue'

const loadTimeoutMs = 60_000

/** Keeps the Sessions route visible while a screen chunk loads and reloads after a failed chunk import. */
export function createRetryableSessionScreen(
  loader: () => Promise<Component>,
  fallback: Component,
  reload: () => void,
  timeoutMs = loadTimeoutMs,
) {
  return defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs }) {
      const state = ref<'loading' | 'error'>('loading')
      const screen = shallowRef<Component>()
      let attempt = 0
      let timer: ReturnType<typeof setTimeout> | undefined

      function load() {
        const currentAttempt = ++attempt
        if (timer)
          clearTimeout(timer)
        screen.value = undefined
        state.value = 'loading'
        timer = setTimeout(() => {
          if (currentAttempt === attempt)
            state.value = 'error'
        }, timeoutMs)
        void Promise.resolve().then(loader).then((component) => {
          if (currentAttempt === attempt) {
            if (timer)
              clearTimeout(timer)
            screen.value = component
          }
        }).catch(() => {
          if (currentAttempt === attempt) {
            if (timer)
              clearTimeout(timer)
            state.value = 'error'
          }
        })
      }

      function retry() {
        attempt++
        if (timer)
          clearTimeout(timer)
        reload()
      }

      onMounted(load)
      onScopeDispose(() => {
        attempt++
        if (timer)
          clearTimeout(timer)
      })

      return () => screen.value
        ? h(screen.value, attrs)
        : h(fallback, { state: state.value, retry })
    },
  })
}
