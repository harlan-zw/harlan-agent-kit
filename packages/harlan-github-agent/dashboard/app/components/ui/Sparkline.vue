<script setup lang="ts">
import type { BarRect, SparklineFrame } from '../../utils/sparkline.ts'
import { usePreferredReducedMotion } from '@vueuse/core'
import { computed, useId } from 'vue'
import { semanticColors } from '../../utils/semantic-colors.ts'
import { buildBars, minMax, projectPoints } from '../../utils/sparkline.ts'

// Ported from the nuxtseo design-system UiSparkline. The motion-v tracer dot
// is dropped: the CSS tracer line still sweeps on hover, and a looping dot was
// the only piece that needed the dependency.

type Datum = Record<string, number | string>

interface Props {
  data: number[] | Datum[]
  /** Previous period data, when provided, gradient reflects per-point changes */
  previousData?: number[] | Datum[]
  xAxis?: string
  yAxis?: string
  width?: number | string
  height?: number | string
  size?: 'sm' | 'md' | 'lg'
  /** Any CSS colour. Defaults to ink through `--ui-primary`. */
  color?: string
  /** Full gradient color array, overrides color & trend defaults */
  colors?: string[]
  /** Colors for comparison mode [improved, declined, neutral] */
  comparisonColors?: [string, string, string]
  strokeWidth?: number
  /** Max data points to render, larger datasets are downsampled via LTTB */
  maxPoints?: number
  /** SVG preserveAspectRatio, set to "none" to stretch fill */
  preserveAspectRatio?: string
  /** Render style. 'line' (smooth curve), 'bars' (vertical bars for discrete counts), 'step' (stepped line for slow integer-valued metrics) */
  variant?: 'line' | 'bars' | 'step'
  /**
   * Lower-is-better metric.
   *
   * Flips the y-axis so the SMALLEST value sits at the top. With the axis
   * flipped, "line rises" and "metric improved" mean the same thing for every
   * metric, inverted or not. `trend` is negated to match, so it keeps reading
   * as valence (+1 = better) AND as the drawn direction.
   */
  inverted?: boolean
  /** Render the area fill under the line. Defaults to false (Tufte-correct: pure line). Opt in for ambient/background ribbons. */
  area?: boolean
  /** How to render `previousData`. `ghost` (default) draws a thin neutral line behind the current series. `diverging` recolors the current line per-point against the previous value. */
  comparisonStyle?: 'ghost' | 'diverging'
  /** Enable the hover tracer — a brighter line that draws along the path. Driven by `hovered`. */
  interactive?: boolean
  /** Hover state, fed from a parent (e.g. the enclosing UiStat card). */
  hovered?: boolean
}

const {
  data,
  previousData,
  yAxis,
  width,
  height,
  size = 'md',
  color,
  colors,
  comparisonColors = [semanticColors.success.hex, semanticColors.error.hex, semanticColors.neutral.hex],
  strokeWidth = 1.5,
  maxPoints = 80,
  preserveAspectRatio,
  variant = 'line',
  inverted = false,
  area = false,
  comparisonStyle = 'ghost',
  interactive = false,
  hovered = false,
} = defineProps<Props>()

// Reduced motion only gates the CSS tracer now; kept so a future looping
// affordance has the flag ready.
const reducedMotionPref = usePreferredReducedMotion()
const reducedMotion = computed(() => reducedMotionPref.value === 'reduce')

const sizeDefaults: Record<string, { w: number, h: number }> = {
  sm: { w: 96, h: 24 },
  md: { w: 120, h: 32 },
  lg: { w: 160, h: 36 },
}

// Size fallback when `size` isn't one of the named presets. `md` is the
// documented default.
const defaults = computed(() => sizeDefaults[size] ?? sizeDefaults.md!)

// CSS width/height — can be string like "100%" or number
const cssWidth = computed(() => width ?? defaults.value.w)
const cssHeight = computed(() => height ?? defaults.value.h)

// Internal numeric dimensions for viewBox/path calculations
const vbW = computed(() => typeof cssWidth.value === 'number' ? cssWidth.value : defaults.value.w)
const vbH = computed(() => typeof cssHeight.value === 'number' ? cssHeight.value : defaults.value.h)

function normalize(input: number[] | Datum[] | undefined, yAxis?: string): number[] {
  if (!input?.length)
    return []
  if (typeof input[0] === 'number')
    return input as number[]
  const data = input as Datum[]
  // A series can carry null/undefined holes. Detect the key from the first
  // real datum and treat holes as 0 so neither key-detection nor access ever
  // derefs null.
  const first = data.find(d => d != null)
  if (!first)
    return []
  const yKey = yAxis || guessYKey(first)
  return data.map(d => (d == null ? 0 : Number(d[yKey]) || 0))
}

function guessYKey(d: Datum): string {
  for (const key of ['y', 'value', 'clicks', 'impressions', 'count']) {
    if (key in d)
      return key
  }
  const skip = new Set(['x', 'index', 'timestamp', 'date'])
  for (const key of Object.keys(d)) {
    if (!skip.has(key) && typeof d[key] === 'number')
      return key
  }
  return Object.keys(d)[1] ?? Object.keys(d)[0] ?? 'value'
}

/**
 * Largest Triangle Three Buckets — downsamples while preserving visual shape.
 * Keeps first and last points, selects most visually significant point per bucket.
 */
function lttb(vals: number[], target: number): number[] {
  if (vals.length <= target)
    return vals

  const result: number[] = [vals[0]!]
  const bucketSize = (vals.length - 2) / (target - 2)

  let prevIndex = 0
  for (let i = 1; i < target - 1; i++) {
    const bucketStart = Math.floor((i - 1) * bucketSize) + 1
    const bucketEnd = Math.min(Math.floor(i * bucketSize) + 1, vals.length - 1)

    // Average of next bucket (for triangle area calc)
    const nextStart = Math.floor(i * bucketSize) + 1
    const nextEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, vals.length - 1)
    let avgX = 0
    let avgY = 0
    const nextLen = nextEnd - nextStart + 1
    for (let j = nextStart; j <= nextEnd; j++) {
      avgX += j
      avgY += vals[j]!
    }
    avgX /= nextLen
    avgY /= nextLen

    // Pick point in current bucket with largest triangle area
    let maxArea = -1
    let bestIndex = bucketStart
    const px = prevIndex
    const py = vals[prevIndex]!
    for (let j = bucketStart; j <= bucketEnd; j++) {
      const area = Math.abs((px - avgX) * (vals[j]! - py) - (px - j) * (avgY - py))
      if (area > maxArea) {
        maxArea = area
        bestIndex = j
      }
    }

    result.push(vals[bestIndex]!)
    prevIndex = bestIndex
  }

  result.push(vals.at(-1)!)
  return result
}

const values = computed(() => lttb(normalize(data, yAxis), maxPoints))
const prevValues = computed(() => lttb(normalize(previousData, yAxis), maxPoints))
const hasComparison = computed(() => prevValues.value.length > 0)

// Trend from half-window MEANS, not endpoints: daily series are seasonal (a
// weekend last point read as "downward" against a Wednesday first point) and
// endpoint comparison also amplifies reporting-lag artifacts. A <2% relative
// difference reads as flat.
const trend = computed<-1 | 0 | 1>(() => {
  const v = values.value
  if (v.length < 2)
    return 0
  const mid = Math.floor(v.length / 2)
  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length
  const early = mean(v.slice(0, mid))
  const late = mean(v.slice(mid))
  const base = Math.max(Math.abs(early), Math.abs(late))
  const dir = base === 0 || Math.abs(late - early) / base < 0.02 ? 0 : late > early ? 1 : -1
  // Not a double-negation with the flipped axis — the two cancel by design.
  // `dir` is computed from the raw VALUES, where "up" means a bigger number; on
  // an inverted metric a bigger number is worse AND is drawn lower. Negating
  // here makes `trend` agree with both: +1 = better = the line goes up.
  return inverted ? (-dir as -1 | 0 | 1) : dir
})

// Charts convey data visually only, so the sr-label carries direction AND the
// early/recent averages (matching how `trend` is computed) rather than the
// seasonal-noise-prone endpoints. An inverted metric gets valence words, not
// line words.
const ariaLabel = computed(() => {
  const v = values.value
  const dir = inverted
    ? (trend.value === 1 ? 'improving' : trend.value === -1 ? 'worsening' : 'flat')
    : (trend.value === 1 ? 'upward' : trend.value === -1 ? 'downward' : 'flat')
  if (v.length < 2)
    return `Sparkline, ${dir} trend`
  const fmt = (n: number) => Math.abs(n) >= 10 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(2)
  const mid = Math.floor(v.length / 2)
  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length
  return `Sparkline, ${dir} trend, averaging ${fmt(mean(v.slice(0, mid)))} early to ${fmt(mean(v.slice(mid)))} recently`
})

// Per-point comparison colors: at each data point, compare current vs previous
const comparisonGradientColors = computed<string[]>(() => {
  const curr = values.value
  const prev = prevValues.value
  if (!prev.length)
    return []

  const [up, down, flat] = comparisonColors
  // `curr` and `prev` are LTTB-downsampled independently, so they pick
  // different representative indices. Map by fractional position instead
  // (both span the same period), so the per-point valence compares like-for-like.
  return curr.map((v, i) => {
    const frac = curr.length > 1 ? i / (curr.length - 1) : 0
    const pIdx = Math.round(frac * (prev.length - 1))
    const p = prev[pIdx] ?? prev.at(-1) ?? 0
    if (v > p)
      return up
    if (v < p)
      return down
    return flat
  })
})

const gradientColors = computed(() => {
  if (hasComparison.value && comparisonStyle === 'diverging' && comparisonGradientColors.value.length >= 2)
    return comparisonGradientColors.value

  const seed = semanticColors.neutral.hex
  if (colors)
    return colors
  if (color)
    return [seed, color]
  // Ink. A sparkline with no colour of its own belongs to the page, not to a series.
  return [seed, 'var(--ui-primary)']
})

// Ghost line projection of previousData — drawn behind the current line in a
// muted color so the reader sees both periods without per-point color churn.
// Shares `sharedYScale` with the current line for honest comparison.
const prevPathD = computed(() => {
  if (!hasComparison.value || comparisonStyle !== 'ghost' || variant === 'bars')
    return ''
  if (prevValues.value.length < 2)
    return ''
  return variant === 'step'
    ? buildStepPath(prevValues.value)
    : buildPath(prevValues.value)
})

// Build gradient stops for SVG linearGradient (evenly spaced)
const gradientStops = computed(() => {
  const colors = gradientColors.value
  if (colors.length <= 1)
    return [{ offset: '0%', color: colors[0] || 'var(--ui-text-dimmed)' }, { offset: '100%', color: colors[0] || 'var(--ui-text-dimmed)' }]
  return colors.map((color, i) => ({
    offset: `${(i / (colors.length - 1)) * 100}%`,
    color,
  }))
})

// Single-pass min/max — avoids `Math.min(...arr)` spread (which allocates an
// args array and risks a call-stack overflow on large series). Lives in
// utils/sparkline.ts with the rest of the drawing geometry.

// The drawing frame the pure geometry reads, so the projection stays a
// function of its inputs.
const frame = computed<SparklineFrame>(() => ({
  width: vbW.value,
  height: vbH.value,
  strokeWidth,
  inverted,
}))

// Shared y-scale when rendering current + previous as overlay (ghost mode).
const sharedYScale = computed<{ min: number, max: number } | undefined>(() => {
  if (!hasComparison.value || comparisonStyle !== 'ghost' || variant === 'bars')
    return undefined
  const all = [...values.value, ...prevValues.value]
  if (!all.length)
    return undefined
  return minMax(all)
})

function buildPath(vals: number[]): string {
  if (vals.length < 2)
    return ''

  const { padY, chartH, points } = projectPoints(vals, frame.value, sharedYScale.value)
  // Catmull-Rom control points overshoot local extremes: at an asymmetric peak
  // the control point lands above the chart top and the SVG viewport clips the
  // curve flat. Clamping control-point Y to the chart area keeps the whole
  // cubic inside it (Bézier convex-hull property).
  const clampY = (y: number) => Math.min(padY + chartH, Math.max(padY, y))

  const segments: string[] = [`M ${points[0]!.x} ${points[0]!.y}`]
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)]!
    const p1 = points[i]!
    const p2 = points[i + 1]!
    const p3 = points[Math.min(i + 2, points.length - 1)]!

    const tension = 0.3
    const cp1x = p1.x + (p2.x - p0.x) * tension
    const cp1y = clampY(p1.y + (p2.y - p0.y) * tension)
    const cp2x = p2.x - (p3.x - p1.x) * tension
    const cp2y = clampY(p2.y - (p3.y - p1.y) * tension)

    segments.push(`C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`)
  }

  return segments.join(' ')
}

function buildStepPath(vals: number[]): string {
  if (vals.length < 2)
    return ''
  const { points } = projectPoints(vals, frame.value, sharedYScale.value)
  const segments: string[] = [`M ${points[0]!.x} ${points[0]!.y}`]
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!
    const prev = points[i - 1]!
    segments.push(`L ${p.x} ${prev.y}`, `L ${p.x} ${p.y}`)
  }
  return segments.join(' ')
}

const strokeGradientId = useId()
const areaGradientId = `${strokeGradientId}-area`

const pathD = computed(() => {
  if (values.value.length < 2)
    return ''
  return variant === 'step' ? buildStepPath(values.value) : buildPath(values.value)
})

const bars = computed<BarRect[]>(() => variant === 'bars' ? buildBars(values.value, frame.value) : [])

const areaPathD = computed(() => {
  // With `projectPoints` flipping the axis, an inverted line sits above the
  // floor the same way any other metric does, so the fill is an ordinary
  // under-curve area. A caller passing `area` gets an area.
  if (!pathD.value || variant === 'bars' || !area)
    return ''
  const padX = strokeWidth
  const closeY = vbH.value - strokeWidth
  return `${pathD.value} L ${vbW.value - padX} ${closeY} L ${padX} ${closeY} Z`
})

const endColor = computed(() => gradientColors.value.at(-1) || 'var(--ui-text-dimmed)')
const areaY1 = computed(() => trend.value === -1 ? '1' : '0')
const areaY2 = computed(() => trend.value === -1 ? '0' : '1')
</script>

<template>
  <!-- overflow-visible: with non-scaling-stroke, a sparkline rendered smaller
       than its viewBox shrinks the padding below the (constant, screen-px)
       stroke half-width. Sub-pixel bleed beats clipped peaks. -->
  <svg
    v-if="pathD || bars.length"
    data-ui="UiSparkline"
    class="overflow-visible"
    :width="cssWidth"
    :height="cssHeight"
    :viewBox="`0 0 ${vbW} ${vbH}`"
    :preserveAspectRatio="preserveAspectRatio"
    role="img"
    :aria-label="ariaLabel"
  >
    <defs>
      <linearGradient :id="strokeGradientId" x1="0" y1="0" x2="1" y2="0">
        <stop
          v-for="stop in gradientStops"
          :key="stop.offset"
          :offset="stop.offset"
          :style="{ stopColor: stop.color }"
        />
      </linearGradient>
      <linearGradient :id="areaGradientId" x1="0" :y1="areaY1" x2="0" :y2="areaY2">
        <stop offset="0%" :style="{ stopColor: endColor, stopOpacity: 0.25 }" />
        <stop offset="100%" :style="{ stopColor: endColor, stopOpacity: 0 }" />
      </linearGradient>
    </defs>
    <template v-if="variant === 'bars'">
      <rect
        v-for="(b, i) in bars"
        :key="i"
        :x="b.x"
        :y="b.y"
        :width="b.w"
        :height="b.h"
        :fill="`url(#${strokeGradientId})`"
        rx="1"
      />
    </template>
    <template v-else>
      <path :d="areaPathD" :fill="`url(#${areaGradientId})`" stroke="none" />
      <path
        v-if="prevPathD"
        :d="prevPathD"
        :stroke="semanticColors.neutral.hex"
        :stroke-width="Math.max(0.75, strokeWidth - 0.5)"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-opacity="0.35"
        fill="none"
        vector-effect="non-scaling-stroke"
      />
      <path
        :d="pathD"
        :stroke="`url(#${strokeGradientId})`"
        :stroke-width="strokeWidth"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"
        vector-effect="non-scaling-stroke"
      />
      <!-- Hover tracer: a brighter copy of the line that draws itself along the
           path on hover (pathLength=1 normalises dasharray regardless of scale). -->
      <path
        v-if="interactive && pathD"
        class="ui-sparkline-tracer"
        :class="{ 'is-hovered': hovered && !reducedMotion }"
        :d="pathD"
        :stroke="endColor"
        :stroke-width="strokeWidth + 0.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"
        pathLength="1"
        vector-effect="non-scaling-stroke"
      />
    </template>
  </svg>
</template>

<style scoped>
/* Tracer rests fully retracted (offset = full length) and draws to 0 on hover,
   so a brighter line sweeps left→right along the data. */
.ui-sparkline-tracer {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  opacity: 0;
  transition:
    stroke-dashoffset 700ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 200ms ease-out;
}
.ui-sparkline-tracer.is-hovered {
  stroke-dashoffset: 0;
  opacity: 0.9;
}
@media (prefers-reduced-motion: reduce) {
  .ui-sparkline-tracer {
    transition: opacity 150ms ease-out;
    stroke-dashoffset: 0;
  }
}
</style>
