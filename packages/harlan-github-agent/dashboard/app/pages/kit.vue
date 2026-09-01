<script setup lang="ts">
import type { DropdownMenuItem, TableColumn } from '@nuxt/ui'
import type { DetailItem } from '../components/DetailList.vue'

/**
 * The design system, rendered. Dev only: no page links here and the service never serves it.
 *
 * Contrast ratios are measured in the browser from the resolved tokens, so a
 * token change shows its consequence here before it ships.
 */
definePageMeta({ layout: false })
usePageTitle('Kit')

const colorMode = useColorMode()

function toggleColorMode(): void {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}

type Rgb = [number, number, number]

interface Swatch {
  name: string
  hex: string
  /** Contrast against each intended background, labelled. */
  ratios: Array<{ against: string, ratio: number }>
}

const surfaceTokens = ['--ui-bg', '--ui-bg-muted', '--ui-bg-elevated', '--ui-bg-accented', '--ui-bg-inverted']
const textTokens = ['--ui-text', '--ui-text-toned', '--ui-text-muted', '--ui-text-dimmed', '--ui-text-inverted']
const borderTokens = ['--ui-border', '--ui-border-accented']
const semanticTokens = ['--ui-primary', '--ui-success', '--ui-warning', '--ui-error']
const statusClasses = ['status-success', 'status-warning', 'status-error']

const surfaces = ref<Swatch[]>([])
const texts = ref<Swatch[]>([])
const borders = ref<Swatch[]>([])
const semantics = ref<Swatch[]>([])
const statuses = ref<Swatch[]>([])

function luminance([r, g, b]: Rgb): number {
  const channel = (v: number): number => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

/** Browsers composite `bg-x/10` in sRGB, so the tint is measured the same way. */
function tint(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((v, i) => Math.round(v * alpha + bg[i]! * (1 - alpha))) as Rgb
}

function measure(): void {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null)
    return
  const parse = (value: string): Rgb => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = value
    context.fillRect(0, 0, 1, 1)
    const data = context.getImageData(0, 0, 1, 1).data
    return [data[0]!, data[1]!, data[2]!]
  }
  const root = getComputedStyle(document.documentElement)
  const token = (name: string): Rgb => parse(root.getPropertyValue(name).trim())
  const probe = (className: string): Rgb => {
    const element = document.createElement('span')
    element.className = className
    document.body.append(element)
    const color = parse(getComputedStyle(element).color)
    element.remove()
    return color
  }

  const bg = token('--ui-bg')
  const bgMuted = token('--ui-bg-muted')
  const bgElevated = token('--ui-bg-elevated')
  const text = token('--ui-text')
  const textInverted = token('--ui-text-inverted')
  const steps: Array<[string, Rgb]> = [['bg', bg], ['muted', bgMuted], ['elevated', bgElevated]]

  surfaces.value = surfaceTokens.map((name) => {
    const rgb = token(name)
    const foreground = name === '--ui-bg-inverted' ? textInverted : text
    return { name, hex: toHex(rgb), ratios: [{ against: name === '--ui-bg-inverted' ? 'text-inverted' : 'text', ratio: contrast(rgb, foreground) }] }
  })
  texts.value = textTokens.map((name) => {
    const rgb = token(name)
    if (name === '--ui-text-inverted')
      return { name, hex: toHex(rgb), ratios: [{ against: 'primary', ratio: contrast(rgb, token('--ui-primary')) }] }
    return { name, hex: toHex(rgb), ratios: steps.map(([against, step]) => ({ against, ratio: contrast(rgb, step) })) }
  })
  borders.value = borderTokens.map((name) => {
    const rgb = token(name)
    return { name, hex: toHex(rgb), ratios: [{ against: 'elevated', ratio: contrast(rgb, bgElevated) }] }
  })
  semantics.value = semanticTokens.map((name) => {
    const rgb = token(name)
    if (name === '--ui-primary')
      return { name, hex: toHex(rgb), ratios: [{ against: 'text-inverted', ratio: contrast(rgb, textInverted) }] }
    return { name, hex: toHex(rgb), ratios: [{ against: 'bg', ratio: contrast(rgb, bg) }, { against: 'elevated', ratio: contrast(rgb, bgElevated) }] }
  })
  statuses.value = statusClasses.map((className) => {
    const rgb = probe(className)
    const base = token(`--ui-${className.replace('status-', '')}`)
    return {
      name: `.${className}`,
      hex: toHex(rgb),
      ratios: [
        { against: 'tint on elevated', ratio: contrast(rgb, tint(base, 0.1, bgElevated)) },
        { against: 'tint on bg', ratio: contrast(rgb, tint(base, 0.1, bg)) },
        { against: 'bg', ratio: contrast(rgb, bg) },
      ],
    }
  })
}

onMounted(measure)
watch(() => colorMode.value, () => {
  requestAnimationFrame(measure)
})

/** Full names, so the client bundle scanner finds every one. The static build has no icon API. */
const icons = [
  'i-octicon-issue-opened-16',
  'i-octicon-git-pull-request-16',
  'i-octicon-git-merge-16',
  'i-octicon-check-16',
  'i-octicon-x-16',
  'i-octicon-dot-fill-16',
  'i-octicon-alert-16',
  'i-octicon-info-16',
  'i-octicon-clock-16',
  'i-octicon-play-16',
  'i-octicon-stop-16',
  'i-octicon-sync-16',
  'i-octicon-terminal-16',
  'i-octicon-gear-16',
  'i-octicon-bell-16',
  'i-octicon-kebab-horizontal-16',
  'i-octicon-chevron-down-16',
  'i-octicon-search-16',
  'i-octicon-eye-16',
  'i-octicon-tools-16',
  'i-octicon-code-16',
  'i-octicon-inbox-16',
  'i-octicon-pulse-16',
  'i-octicon-list-unordered-16',
  'i-octicon-broadcast-16',
  'i-octicon-zap-16',
  'i-octicon-code-review-16',
  'i-octicon-checklist-16',
  'i-octicon-telescope-16',
  'i-octicon-workflow-16',
]

const typeScale = [
  { label: '0.75rem 500 field-label', class: 'field-label', text: 'Needs you' },
  { label: '0.875rem 400 body', class: 'text-sm', text: 'Blocked on a draft. Issue work stops above 8 open pull requests, and 17 are open.' },
  { label: '1rem 500 card title', class: 'text-base font-medium', text: 'fix(agent): unblock automated PR repairs' },
  { label: '1.125rem 600 page title', class: 'text-lg font-semibold', text: 'History' },
  { label: '0.875rem mono', class: 'font-mono text-sm', text: '2670f98e · 04:12 · position 03' },
]

const menuItems: DropdownMenuItem[][] = [
  [
    { label: 'Open on GitHub', icon: 'i-octicon-link-external-16' },
    { label: 'Rerun review', icon: 'i-octicon-sync-16' },
  ],
  [
    { label: 'Cancel task', icon: 'i-octicon-x-16', color: 'error' },
    { label: 'Dismiss', icon: 'i-octicon-circle-slash-16', color: 'error' },
  ],
]

const details: DetailItem[] = [
  { term: 'Session', value: 'ses_01J9X4K2', mono: true },
  { term: 'Commit', value: '2670f98e', mono: true, href: 'https://github.com/harlan-zw/harlan-agent-kit/commit/2670f98e' },
  { term: 'Phase', value: 'Repair' },
  { term: 'Elapsed', value: '04:12', mono: true },
]

interface WatchingRow {
  repository: string
  open: number
  polled: string
}

const watchingRows: WatchingRow[] = [
  { repository: 'harlan-zw/nuxt-seo', open: 12, polled: '40s ago' },
  { repository: 'harlan-zw/unhead', open: 3, polled: '1m ago' },
  { repository: 'harlan-zw/harlan-agent-kit', open: 1, polled: '2m ago' },
]

const watchingColumns: TableColumn<WatchingRow>[] = [
  { accessorKey: 'repository', header: 'Repository' },
  { accessorKey: 'open', header: 'Open items' },
  { accessorKey: 'polled', header: 'Polled' },
]

const historyRows = [
  { work: 'adversarial_review', title: 'feat(dashboard): board columns', repository: 'harlan-zw/harlan-agent-kit', number: 124, tone: 'success', outcome: 'READY', confidence: 92, at: '3m ago' },
  { work: 'review_fix', title: 'fix(sitemap): trailing slash on index', repository: 'harlan-zw/nuxt-seo', number: 611, tone: 'warning', outcome: 'PENDING', at: '18m ago' },
  { work: 'issue_work', title: 'chore(deps): bump unhead', repository: 'harlan-zw/unhead', number: 402, tone: 'error', outcome: 'BLOCKED', at: '1h ago' },
] as const

const ejected = ref(0)
</script>

<template>
  <div class="mx-auto max-w-[100rem] px-6 pb-16 xl:px-10">
    <header class="flex h-12 items-center justify-between border-b border-default">
      <span class="text-base font-semibold">Kit</span>
      <UButton
        :icon="colorMode.value === 'dark' ? 'i-octicon-sun-16' : 'i-octicon-moon-16'"
        color="neutral"
        variant="ghost"
        square
        aria-label="Toggle theme"
        @click="toggleColorMode"
      />
    </header>

    <section class="mt-10 border-t border-default pt-6">
      <h2 class="field-label mb-4">
        Colours
      </h2>
      <div class="grid gap-6 lg:grid-cols-2">
        <div v-for="group in [['Surfaces', surfaces], ['Text', texts], ['Borders', borders], ['Semantic', semantics], ['Status text', statuses]] as const" :key="group[0]">
          <p class="mb-2 font-mono text-xs text-dimmed">
            {{ group[0] }}
          </p>
          <ul class="divide-y divide-default rounded-md ring ring-default">
            <li v-for="swatch in group[1]" :key="swatch.name" class="flex min-h-11 items-center gap-3 px-3 py-2">
              <span
                class="size-6 shrink-0 rounded-sm ring ring-inset ring-default"
                :style="{ background: swatch.hex }"
                aria-hidden="true"
              />
              <span class="w-44 shrink-0 font-mono text-xs">{{ swatch.name }}</span>
              <span class="w-20 shrink-0 font-mono text-xs text-muted">{{ swatch.hex }}</span>
              <span class="flex flex-wrap gap-x-3 font-mono text-xs text-dimmed">
                <span v-for="ratio in swatch.ratios" :key="ratio.against">
                  {{ ratio.against }}
                  <span :class="ratio.ratio >= 4.5 ? 'text-default' : ratio.ratio >= 3 ? 'status-warning' : 'status-error'">{{ ratio.ratio.toFixed(2) }}</span>
                </span>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <section class="mt-10 border-t border-default pt-6">
      <h2 class="field-label mb-4">
        Typography
      </h2>
      <ul class="divide-y divide-default">
        <li v-for="row in typeScale" :key="row.label" class="flex min-h-11 items-center gap-6 py-2">
          <span class="w-56 shrink-0 font-mono text-xs text-dimmed">{{ row.label }}</span>
          <span :class="row.class">{{ row.text }}</span>
        </li>
      </ul>
    </section>

    <section class="mt-10 border-t border-default pt-6">
      <h2 class="field-label mb-4">
        Icons
      </h2>
      <ul class="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
        <li v-for="name in icons" :key="name" class="flex h-9 items-center gap-2 px-2">
          <UIcon :name="name" class="size-4 shrink-0" aria-hidden="true" />
          <span class="truncate font-mono text-xs text-muted">{{ name.slice('i-octicon-'.length, -'-16'.length) }}</span>
        </li>
      </ul>
    </section>

    <section class="mt-10 border-t border-default pt-6">
      <h2 class="field-label mb-4">
        Buttons
      </h2>
      <div class="flex flex-col gap-3">
        <div v-for="variant in ['solid', 'outline', 'ghost'] as const" :key="variant" class="flex flex-wrap items-center gap-3">
          <span class="w-16 font-mono text-xs text-dimmed">{{ variant }}</span>
          <UButton :variant="variant" size="sm">
            Approve
          </UButton>
          <UButton :variant="variant" size="md" icon="i-octicon-play-16">
            Resume
          </UButton>
          <UButton :variant="variant" size="sm" icon="i-octicon-kebab-horizontal-16" square aria-label="More actions" />
          <UButton :variant="variant" size="sm" disabled>
            Approve
          </UButton>
          <UButton :variant="variant" size="sm" loading>
            Approve
          </UButton>
          <UButton v-if="variant !== 'solid'" :variant="variant" color="error" size="sm" icon="i-octicon-x-16">
            Cancel task
          </UButton>
        </div>
      </div>
    </section>

    <section class="mt-10 border-t border-default pt-6">
      <h2 class="field-label mb-4">
        Badges
      </h2>
      <div class="flex flex-wrap items-center gap-3">
        <StateBadge tone="success" label="READY" :confidence="92" uppercase />
        <StateBadge tone="warning" label="PENDING" uppercase />
        <StateBadge tone="error" label="BLOCKED" uppercase />
        <StateBadge tone="neutral" label="Queued" />
        <StateBadge tone="success" label="Passed" />
        <StateBadge tone="error" label="Failed" />
        <UBadge variant="subtle" color="neutral" class="font-mono font-semibold">
          8
        </UBadge>
        <WorkChip work="adversarial_review" />
        <WorkChip work="review_fix" />
        <WorkChip work="issue_work" />
        <WorkChip work="pull_request_triage" />
        <WorkChip work="routine_scan" />
      </div>
    </section>

    <section class="mt-10 border-t border-default pt-6">
      <h2 class="field-label mb-4">
        Cards
      </h2>
      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div class="flex flex-col gap-2 rounded-lg bg-muted p-2">
          <ColumnHeading label="Needs you" :count="1" tone="warning" />
          <UCard>
            <div class="flex items-start justify-between gap-2">
              <EntityIdentity
                author="harlan-zw"
                title="feat(dashboard): board columns and card slideover"
                url="https://github.com/harlan-zw/harlan-agent-kit/pull/124"
                repository="harlan-zw/harlan-agent-kit"
                kind="pull_request"
                :number="124"
              />
              <UDropdownMenu :items="menuItems" :content="{ align: 'end' }">
                <UButton icon="i-octicon-kebab-horizontal-16" color="neutral" variant="ghost" square aria-label="More actions" />
              </UDropdownMenu>
            </div>
            <div class="mt-2 flex items-center gap-2">
              <WorkChip work="adversarial_review" />
              <span class="status-warning text-sm">Outside contributor. Approval required.</span>
            </div>
            <div class="mt-3">
              <UButton size="sm">
                Review and repair
              </UButton>
            </div>
          </UCard>
        </div>

        <div class="flex flex-col gap-2 rounded-lg bg-muted p-2">
          <ColumnHeading label="Up next" :count="2" />
          <UCard>
            <EntityIdentity
              author="danielroe"
              title="fix(sitemap): trailing slash on index route"
              url="https://github.com/harlan-zw/nuxt-seo/pull/611"
              repository="harlan-zw/nuxt-seo"
              kind="pull_request"
              :number="611"
            />
            <div class="mt-2 flex items-center gap-2">
              <WorkChip work="review_fix" />
              <span class="font-mono text-sm text-dimmed">Position 3</span>
            </div>
          </UCard>
          <ColumnHeading label="Waiting" :count="1" />
          <UCard :ui="{ root: 'ring-dashed ring-accented' }">
            <EntityIdentity
              author="antfu"
              title="chore(deps): bump unhead to v3"
              url="https://github.com/harlan-zw/unhead/pull/402"
              repository="harlan-zw/unhead"
              kind="pull_request"
              :number="402"
            />
            <p class="mt-2 text-sm text-muted">
              Blocked on a draft.
            </p>
          </UCard>
        </div>

        <div class="flex flex-col gap-2 rounded-lg bg-muted p-2">
          <ColumnHeading label="Running" :count="1" />
          <UCard>
            <EntityIdentity
              author="harlan-zw"
              title="Sitemap ignores routeRules prerender entries"
              url="https://github.com/harlan-zw/nuxt-seo/issues/598"
              repository="harlan-zw/nuxt-seo"
              kind="issue"
              :number="598"
            />
            <div class="mt-2 flex items-center gap-2">
              <WorkChip work="issue_work" />
              <LiveDot tone="success" live label="Agent running" />
              <span class="text-sm text-muted">Repair</span>
              <span class="font-mono text-sm text-dimmed">04:12</span>
            </div>
            <div class="mt-2 flex justify-end">
              <ConfirmButton
                label="Eject"
                confirm-label="Confirm eject"
                aria-label="Eject this agent"
                confirm-aria-label="Confirm eject of this agent"
                icon="i-octicon-terminal-16"
                @confirm="ejected += 1"
              />
            </div>
          </UCard>
        </div>

        <div class="flex flex-col gap-2 rounded-lg bg-muted p-2">
          <ColumnHeading label="Done" :count="8" />
          <UCard class="text-muted">
            <div class="flex items-center justify-between gap-2">
              <EntityIdentity
                author="harlan-zw"
                title="fix(agent): unblock automated PR repairs"
                url="https://github.com/harlan-zw/harlan-agent-kit/pull/122"
                repository="harlan-zw/harlan-agent-kit"
                kind="pull_request"
                :number="122"
                size="sm"
              />
              <StateBadge tone="success" label="READY" :confidence="92" uppercase />
            </div>
          </UCard>
        </div>
      </div>
      <p v-if="ejected > 0" class="mt-3 font-mono text-sm text-dimmed">
        Eject confirmed {{ ejected }} times.
      </p>
    </section>

    <section class="mt-10 border-t border-default pt-6">
      <h2 class="field-label mb-4">
        List rows
      </h2>
      <ul class="divide-y divide-default border-y border-default">
        <li v-for="row in historyRows" :key="row.number" class="flex min-h-11 flex-wrap items-center gap-3 px-2 py-2 transition-colors hover:bg-muted">
          <WorkChip :work="row.work" />
          <a :href="`https://github.com/${row.repository}/pull/${row.number}`" target="_blank" rel="noreferrer" class="entity-link min-w-0 flex-1 truncate text-sm">{{ row.title }}</a>
          <span class="font-mono text-sm text-dimmed">{{ row.repository }}#{{ row.number }}</span>
          <StateBadge :tone="row.tone" :label="row.outcome" :confidence="'confidence' in row ? row.confidence : undefined" uppercase />
          <span class="w-16 text-right font-mono text-sm text-dimmed">{{ row.at }}</span>
        </li>
      </ul>
    </section>

    <section class="mt-10 border-t border-default pt-6">
      <h2 class="field-label mb-4">
        Table
      </h2>
      <div class="overflow-x-auto rounded-md ring ring-default">
        <UTable :data="watchingRows" :columns="watchingColumns" />
      </div>
    </section>

    <section class="mt-10 border-t border-default pt-6">
      <h2 class="field-label mb-4">
        Detail list
      </h2>
      <DetailList :items="details" :columns="2" />
    </section>

    <section class="mt-10 border-t border-default pt-6">
      <h2 class="field-label mb-4">
        Dots
      </h2>
      <div class="flex items-center gap-6 text-sm">
        <span class="flex items-center gap-2"><LiveDot tone="neutral" /> 0/3</span>
        <span class="flex items-center gap-2"><LiveDot tone="success" live /> 2/3</span>
        <span class="flex items-center gap-2"><LiveDot tone="warning" /> Paused</span>
        <span class="flex items-center gap-2"><LiveDot tone="error" /> 1 Incident</span>
      </div>
    </section>

    <section class="mt-10 border-t border-default pt-6">
      <h2 class="field-label mb-4">
        Sparkline
      </h2>
      <div class="flex items-center gap-2 font-mono text-sm text-muted">
        61°C
        <Sparkline :data="[52, 54, 53, 57, 60, 58, 61, 63, 62, 61]" label="Sample temperature in °C" />
      </div>
    </section>

    <section class="mt-10 border-t border-default pt-6">
      <h2 class="field-label mb-4">
        Inputs
      </h2>
      <div class="flex flex-wrap items-center gap-3">
        <UInput size="sm" icon="i-octicon-search-16" placeholder="Filter repositories" class="w-64" />
        <UInput size="md" placeholder="Repository" class="w-64" />
        <UTooltip text="Finish active work, then restart.">
          <UButton variant="outline" size="sm" icon="i-octicon-sync-16">
            Restart after current work
          </UButton>
        </UTooltip>
      </div>
    </section>

    <section class="mt-10 border-t border-default pt-6">
      <h2 class="field-label mb-4">
        Overlays
      </h2>
      <div class="flex flex-wrap items-center gap-3">
        <USlideover title="harlan-zw/harlan-agent-kit#124" description="feat(dashboard): board columns and card slideover">
          <UButton variant="outline" size="sm">
            Open slideover
          </UButton>
          <template #body>
            <DetailList :items="details" />
            <p class="field-label mt-6 mb-2">
              Terminal
            </p>
            <pre class="terminal">$ pnpm check
lint ✓  typecheck ✓  test ✓ (42 passed)
$ git push origin feat/dashboard-redesign</pre>
          </template>
        </USlideover>

        <UModal title="Dismiss this pull request?" description="This pull request will never run again.">
          <UButton variant="outline" size="sm" color="error" icon="i-octicon-circle-slash-16">
            Dismiss
          </UButton>
          <template #footer="{ close }">
            <UButton variant="ghost" color="neutral" size="sm" @click="close">
              Cancel
            </UButton>
            <UButton size="sm" @click="close">
              Dismiss
            </UButton>
          </template>
        </UModal>

        <UDropdownMenu :items="menuItems" :content="{ align: 'start' }">
          <UButton variant="outline" size="sm" trailing-icon="i-octicon-chevron-down-16">
            Menu
          </UButton>
        </UDropdownMenu>
      </div>
    </section>
  </div>
</template>
