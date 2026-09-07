/**
 * Pure geometry for UiSparkline. The component reads its reactive dimensions
 * and passes them in as a frame, so the math stays a function of its inputs
 * and is unit tested through these exports.
 */

export interface BarRect { x: number, y: number, w: number, h: number }

export interface SparklineFrame {
  /** Internal viewBox width in px. */
  width: number
  /** Internal viewBox height in px. */
  height: number
  strokeWidth: number
  /** Lower-is-better metric: the y-axis flips so the smallest value sits on top. */
  inverted?: boolean
}

/**
 * Single-pass min/max — avoids `Math.min(...arr)` spread (which allocates an
 * args array and risks a call-stack overflow on large series).
 */
export function minMax(arr: number[]): { min: number, max: number } {
  let min = Infinity
  let max = -Infinity
  for (const v of arr) {
    if (v < min)
      min = v
    if (v > max)
      max = v
  }
  return { min, max }
}

/**
 * Smallest peak-to-trough spread, as a fraction of the series' own magnitude,
 * that is allowed to fill the chart height.
 *
 * The y-scale auto-fits, so without a floor ANY spread is stretched to the full
 * height: a metric sitting at 100 that jitters by 0.05 draws the same violent
 * zigzag as one that halved. 8% sits between `trend`'s 2% flat cut and the
 * smallest move a reader would call real. A floor rather than a flat-series
 * short-circuit, deliberately: a threshold that swaps the curve for a straight
 * line flips between refreshes; a floored range degrades continuously.
 */
const FLAT_RANGE_FLOOR = 0.08

/**
 * Widen `bounds` to the floor when the series is flatter than FLAT_RANGE_FLOOR,
 * keeping the data centred in the widened band so a truly constant series draws
 * through the middle rather than pinned to the chart's bottom edge.
 */
function floorRange(bounds: { min: number, max: number }): { min: number, max: number } {
  const spread = bounds.max - bounds.min
  // Magnitude, not spread, sets the floor: "flat" is relative to how big the
  // numbers are. A 0.05 wobble is noise at 100 and a doubling at 0.05.
  const magnitude = Math.max(Math.abs(bounds.max), Math.abs(bounds.min))
  const minRange = magnitude * FLAT_RANGE_FLOOR
  if (!(spread < minRange))
    return bounds
  const mid = (bounds.max + bounds.min) / 2
  return { min: mid - minRange / 2, max: mid + minRange / 2 }
}

export function projectPoints(
  vals: number[],
  frame: SparklineFrame,
  yScale?: { min: number, max: number },
) {
  const padX = frame.strokeWidth
  const padY = frame.strokeWidth
  const chartW = frame.width - padX * 2
  const chartH = frame.height - padY * 2

  const bounds = floorRange(yScale ?? minMax(vals))
  const min = bounds.min
  const max = bounds.max
  const range = max - min || 1

  return {
    padX,
    padY,
    chartW,
    chartH,
    // The ONE place the y-axis direction is decided, so nothing downstream
    // (line, step, bars, area close, tracer) can disagree about which way is up.
    points: vals.map((v, i) => {
      const t = (v - min) / range
      // One datum has no span to divide across: `i / (length - 1)` turns into
      // 0/0 and the NaN x makes SVG drop the shape, so a single point is
      // centered in the chart instead.
      const x = vals.length === 1
        ? padX + chartW / 2
        : padX + (i / (vals.length - 1)) * chartW
      return {
        x,
        y: frame.inverted === true ? padY + t * chartH : padY + chartH - t * chartH,
      }
    }),
  }
}

export function buildBars(vals: number[], frame: SparklineFrame): BarRect[] {
  if (!vals.length)
    return []
  const { padY, chartW, chartH, points } = projectPoints(vals, frame)
  const gapRatio = 0.3
  const slotW = chartW / vals.length
  const barW = Math.max(1, slotW * (1 - gapRatio))
  const baselineY = padY + chartH
  return points.map(p => ({
    x: p.x - barW / 2,
    y: p.y,
    w: barW,
    h: Math.max(1, baselineY - p.y),
  }))
}
