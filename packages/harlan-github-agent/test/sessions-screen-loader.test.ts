import type { Component } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick } from 'vue'
import { createRetryableSessionScreen } from '../dashboard/app/utils/sessions-screen-loader.ts'

interface HostNode {
  type: string
  text: string
  props: Record<string, unknown>
  children: HostNode[]
  parent?: HostNode
}

const renderer = createRenderer<HostNode, HostNode>({
  createElement: type => ({ type, text: '', props: {}, children: [] }),
  createText: text => ({ type: '#text', text, props: {}, children: [] }),
  createComment: text => ({ type: '#comment', text, props: {}, children: [] }),
  setText: (node, text) => { node.text = text },
  setElementText(node, text) {
    node.children = []
    node.text = text
  },
  patchProp: (node, key, _prior, value) => { node.props[key] = value },
  insert(node, parent, anchor) {
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0)
      parent.children.push(node)
    else
      parent.children.splice(index, 0, node)
  },
  remove(node) {
    const parent = node.parent
    if (parent)
      parent.children.splice(parent.children.indexOf(node), 1)
  },
  parentNode: node => node.parent ?? null,
  nextSibling(node) {
    const siblings = node.parent?.children ?? []
    return siblings[siblings.indexOf(node) + 1] ?? null
  },
})

const stateFallback = defineComponent({
  props: { state: { type: String, required: true }, retry: { type: Function, required: false } },
  setup(props) {
    return () => props.state === 'loading'
      ? h('p', { role: 'status' }, 'Opening Sessions…')
      : h('div', { role: 'alert' }, [
          h('p', 'Could not open Sessions. Retry.'),
          h('button', { onClick: props.retry }, 'Retry'),
        ])
  },
})

function textContent(node: HostNode): string {
  return node.text + node.children.map(textContent).join('')
}

function findNode(node: HostNode, predicate: (value: HostNode) => boolean): HostNode | undefined {
  if (predicate(node))
    return node
  for (const child of node.children) {
    const result = findNode(child, predicate)
    if (result)
      return result
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function settle() {
  for (let index = 0; index < 8; index++)
    await Promise.resolve()
  await nextTick()
}

describe('retryable Sessions screen imports', () => {
  it('shows a pending state until the screen chunk resolves', async () => {
    const pending = deferred<Component>()
    const Screen = createRetryableSessionScreen(() => pending.promise, stateFallback, vi.fn())
    const root: HostNode = { type: 'root', text: '', props: {}, children: [] }
    const app = renderer.createApp({ render: () => h(Screen) })

    app.mount(root)
    await nextTick()
    expect(textContent(root)).toContain('Opening Sessions…')

    pending.resolve(defineComponent({ setup: () => () => h('p', 'Workspace ready') }))
    await settle()
    expect(textContent(root)).toContain('Workspace ready')
    app.unmount()
  })

  it('offers a document retry after a rejected module import', async () => {
    const first = deferred<Component>()
    const reload = vi.fn()
    const loader = vi.fn(() => first.promise)
    const Screen = createRetryableSessionScreen(loader, stateFallback, reload)
    const root: HostNode = { type: 'root', text: '', props: {}, children: [] }
    const app = renderer.createApp({ render: () => h(Screen) })

    app.mount(root)
    first.reject(new Error('chunk unavailable'))
    await settle()
    expect(textContent(root)).toContain('Could not open Sessions. Retry.')

    const retry = findNode(root, node => node.type === 'button')?.props.onClick
    if (typeof retry !== 'function')
      throw new Error('Retry action is missing')
    retry()
    await settle()
    expect(reload).toHaveBeenCalledOnce()
    expect(loader).toHaveBeenCalledOnce()
    first.resolve(defineComponent({ setup: () => () => h('p', 'Late stale screen') }))
    await settle()
    expect(textContent(root)).toContain('Could not open Sessions. Retry.')
    expect(textContent(root)).not.toContain('Late stale screen')
    app.unmount()
  })

  it('turns a stalled import into a retryable error and ignores its late completion', async () => {
    const first = deferred<Component>()
    const reload = vi.fn()
    const loader = vi.fn(() => first.promise)
    const Screen = createRetryableSessionScreen(loader, stateFallback, reload, 10)
    const root: HostNode = { type: 'root', text: '', props: {}, children: [] }
    const app = renderer.createApp({ render: () => h(Screen) })
    vi.useFakeTimers()

    try {
      app.mount(root)
      await nextTick()
      expect(textContent(root)).toContain('Opening Sessions…')
      await vi.advanceTimersByTimeAsync(10)
      await nextTick()
      expect(textContent(root)).toContain('Could not open Sessions. Retry.')

      const retry = findNode(root, node => node.type === 'button')?.props.onClick
      if (typeof retry !== 'function')
        throw new Error('Retry action is missing')
      retry()
      await settle()
      expect(reload).toHaveBeenCalledOnce()
      expect(loader).toHaveBeenCalledOnce()

      first.resolve(defineComponent({ setup: () => () => h('p', 'Late stale screen') }))
      await settle()
      expect(textContent(root)).toContain('Could not open Sessions. Retry.')
      expect(textContent(root)).not.toContain('Late stale screen')
    }
    finally {
      app.unmount()
      vi.useRealTimers()
    }
  })
})
