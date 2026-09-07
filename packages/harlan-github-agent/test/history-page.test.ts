import type { Component, VNode } from 'vue'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { compileTemplate, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'

/**
 * The dashboard has no component-test environment, so a page renders here
 * through its own compiled template: the template is the page's API, and the
 * assertion is on rendered output. Setup bindings and auto-imported
 * components are provided by the harness; only the markup under test is real.
 */
function loadTemplateRender(code: string, modules: Array<Record<string, unknown>>): () => VNode {
  const body = code.replace(/import\s*\{([^}]+)\}\s*from\s*"([^"]*)";?/g, (_, names: string, source: string) => {
    const index = source === 'vue' ? 0 : 1
    return `const { ${names.trim().replace(/\s+as\s+/g, ': ')} } = modules[${index}];\n`
  })
  // The compiled template is a module string, not a file, so it needs a dynamic evaluation scope.
  // eslint-disable-next-line no-new-func
  const factory = new Function('modules', `${body.replaceAll('export function', 'function')}; return render`)
  return factory(modules) as () => VNode
}

async function renderPageTemplate(path: string, setup: Record<string, unknown>): Promise<string> {
  const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path })
  const compiled = compileTemplate({ id: 'test', filename: path, source: descriptor.template!.content })
  if (compiled.errors.length > 0)
    throw new Error(compiled.errors.join('\n'))

  const stub: Component = (_, { slots }) => h('div', slots.default?.())
  const app = createSSRApp({ setup: () => setup, render: loadTemplateRender(compiled.code, [await import('vue'), await import('vue/server-renderer')]) })
  app.component('UiSectionHeader', stub)
  app.component('UiEmptyState', stub)
  app.component('HistoryEvidenceSlideover', () => null)
  app.component('StateBadge', () => null)
  app.component('WorkChip', () => null)
  app.component('EntityIdentity', () => null)
  app.component('UButton', stub)
  app.component('USkeleton', () => null)
  app.component('UDropdownMenu', stub)
  return renderToString(app)
}

const historyPage = new URL('../dashboard/app/pages/history.vue', import.meta.url).pathname

const pageState: Record<string, unknown> = {
  rows: [],
  allRows: [],
  loading: false,
  outcomeFilter: 'all',
  outcomeFilters: [],
  range: { _tag: 'Plain' },
  selected: undefined,
  selectedKey: undefined,
  slideoverOpen: false,
  rerunPending: undefined,
  rerunErrors: {},
  emptyLine: '',
  relativeTime: () => '',
  duration: () => undefined,
  rowDuration: () => undefined,
  rowRerunError: () => undefined,
  rowName: () => '',
  menuItems: () => [],
  historyRowBadge: () => ({ tone: 'neutral', label: '', uppercase: false }),
  historyRowWork: () => 'adversarial_review',
  historyRowUrl: () => '',
  taskNumber: () => 0,
  taskSubjectUrl: () => '',
  taskRowSummary: () => undefined,
  routineRunPresentation: () => ({ label: '', tone: 'neutral', detail: undefined }),
}

describe('history page outline', () => {
  it('renders a level-1 heading named History', async () => {
    const html = await renderPageTemplate(historyPage, pageState)
    expect(html).toMatch(/<h1[^>]*>\s*History\s*<\/h1>/)
  })
})
