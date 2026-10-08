<script setup lang="ts">
import type { VNodeChild } from 'vue'
import type { SessionInline, SessionMarkdownBlock } from '../utils/session-markdown.ts'
import { defineComponent, h } from 'vue'
import { sessionMarkdown } from '../utils/session-markdown.ts'
import SessionCode from './_SessionCode.vue'

const { text } = defineProps<{ text: string }>()

function inline(nodes: SessionInline[]): VNodeChild[] {
  return nodes.map((node): VNodeChild => {
    switch (node.kind) {
      case 'text': return node.text
      case 'code': return h('code', { class: 'rounded bg-muted px-1.5 py-0.5 font-mono text-sm break-words' }, node.text)
      case 'strong': return h('strong', { class: 'font-semibold' }, inline(node.content))
      case 'emphasis': return h('em', inline(node.content))
      case 'strike': return h('del', inline(node.content))
      case 'link': return node.href === null ? h('span', inline(node.content)) : h('a', { href: node.href, target: node.href.startsWith('http') ? '_blank' : undefined, rel: 'noopener noreferrer', class: 'underline decoration-accented underline-offset-4 hover:decoration-current break-words' }, inline(node.content))
      case 'break': return h('br')
    }
    return null
  })
}

function render(blocks: SessionMarkdownBlock[]): VNodeChild[] {
  return blocks.map((block): VNodeChild => {
    switch (block.kind) {
      case 'paragraph': return h('p', { class: 'my-3 whitespace-pre-wrap break-words leading-7' }, inline(block.content))
      case 'heading': return h(`h${Math.min(6, block.level + 1)}`, { class: `mb-3 mt-6 font-semibold text-highlighted ${block.level < 3 ? 'text-lg' : 'text-base'}` }, inline(block.content))
      case 'code': return h(SessionCode, { text: block.text, language: block.language })
      case 'quote': return h('blockquote', { class: 'my-4 border-l-2 border-accented pl-4 text-toned' }, render(block.blocks))
      case 'list': return h(block.ordered ? 'ol' : 'ul', { class: `my-3 space-y-1 pl-6 ${block.ordered ? 'list-decimal' : 'list-disc'}`, start: block.ordered ? block.start : undefined }, block.items.map(item => h('li', { class: item.checked === null ? '' : 'list-none -ml-5' }, [item.checked === null ? null : h('input', { 'type': 'checkbox', 'checked': item.checked, 'disabled': true, 'aria-label': 'Task completed', 'class': 'mr-2' }), ...render(item.blocks)])))
      case 'table': return h('div', { 'class': 'my-4 max-w-full overflow-x-auto rounded-md border border-default', 'tabindex': 0, 'role': 'region', 'aria-label': 'Message table' }, [h('table', { class: 'min-w-full text-left text-sm' }, [h('thead', { class: 'bg-muted' }, [h('tr', block.header.map(cell => h('th', { class: 'px-3 py-2 font-medium whitespace-nowrap' }, inline(cell))))]), h('tbody', block.rows.map(row => h('tr', { class: 'border-t border-default' }, row.map(cell => h('td', { class: 'px-3 py-2' }, inline(cell))))))])])
      case 'rule': return h('hr', { class: 'my-6 border-default' })
    }
    return null
  })
}
const Content = defineComponent({ setup: () => () => h('div', { class: 'min-w-0 text-base' }, render(sessionMarkdown(text))) })
</script>

<template>
  <Content />
</template>
