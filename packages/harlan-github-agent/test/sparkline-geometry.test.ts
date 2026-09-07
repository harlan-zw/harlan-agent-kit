import type { SparklineFrame } from '../dashboard/app/utils/sparkline.ts'
import { describe, expect, it } from 'vitest'
import { buildBars } from '../dashboard/app/utils/sparkline.ts'

const frame: SparklineFrame = { width: 160, height: 36, strokeWidth: 1.5, inverted: false }

describe('sparkline bar geometry', () => {
  it('draws a single datum as one centered bar instead of a NaN rect SVG drops', () => {
    const [bar] = buildBars([5], frame)

    expect(Number.isFinite(bar!.x)).toBe(true)
    expect(Number.isFinite(bar!.y)).toBe(true)
    expect(bar!.w).toBeGreaterThanOrEqual(1)
    expect(bar!.h).toBeGreaterThanOrEqual(1)
    const chartCenterX = frame.strokeWidth + (frame.width - frame.strokeWidth * 2) / 2
    expect(bar!.x + bar!.w / 2).toBe(chartCenterX)
  })

  it('keeps multi-point bars spanning the chart edge to edge', () => {
    const bars = buildBars([1, 2, 3], frame)

    expect(bars[0]!.x).toBeLessThan(bars[1]!.x)
    expect(bars[1]!.x).toBeLessThan(bars[2]!.x)
    for (const bar of bars) {
      expect(Number.isFinite(bar.x)).toBe(true)
      expect(bar.h).toBeGreaterThanOrEqual(1)
    }
  })
})
