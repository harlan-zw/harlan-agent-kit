/**
 * Centralized semantic color system, ported from the nuxtseo design system.
 *
 * Three concerns:
 * 1. **Status colors** — success/error/warning/info/neutral for health, connection, validation states
 * 2. **Threshold colors** — good/needs-attention/poor
 * 3. **Trend colors** — positive (green) / negative (red) / neutral for change values
 *
 * Text classes resolve to this dashboard's `.status-*` ramp, which mixes the
 * Primer foreground toward ink or paper so it clears AA on a tint. The app has
 * no info colour, so `info` renders as neutral.
 */

export type SemanticStatus = 'success' | 'error' | 'warning' | 'info' | 'neutral'
export type HealthStatus = 'healthy' | 'attention' | 'issues' | 'unknown'

export interface SemanticColorSet {
  text: string
  bg: string
  dot: string
  border: string
  hex: string
}

/** Full class sets for each semantic status */
export const semanticColors: Record<SemanticStatus, SemanticColorSet> = {
  success: { text: 'status-success', bg: 'bg-success/10', dot: 'bg-success', border: 'border-success/20', hex: '#1a7f37' },
  error: { text: 'status-error', bg: 'bg-error/10', dot: 'bg-error', border: 'border-error/20', hex: '#cf222e' },
  warning: { text: 'status-warning', bg: 'bg-warning/10', dot: 'bg-warning', border: 'border-warning/20', hex: '#9a6700' },
  info: { text: 'text-muted', bg: 'bg-accented', dot: 'bg-accented', border: 'border-default', hex: '#78746d' },
  neutral: { text: 'text-muted', bg: 'bg-accented', dot: 'bg-accented', border: 'border-default', hex: '#78746d' },
}

/** Map dashboard health status to semantic status */
export function healthToSemantic(health: HealthStatus | null): SemanticStatus {
  switch (health) {
    case 'healthy': return 'success'
    case 'attention': return 'warning'
    case 'issues': return 'error'
    default: return 'neutral'
  }
}

/** Map a numeric value against good/poor thresholds to semantic status */
export function thresholdToSemantic(value: number, good: number, poor: number): SemanticStatus {
  if (value <= good)
    return 'success'
  if (value <= poor)
    return 'warning'
  return 'error'
}

/** Map a trend direction to semantic status — positive=success, negative=error, zero=neutral */
export function trendToSemantic(value: number): SemanticStatus {
  if (value > 0)
    return 'success'
  if (value < 0)
    return 'error'
  return 'neutral'
}

/** Shorthand: get the full color set for a health status */
export function healthColors(health: HealthStatus | null): SemanticColorSet {
  return semanticColors[healthToSemantic(health)]
}

/** Shorthand: get the full color set for a threshold value */
export function thresholdColors(value: number, good: number, poor: number): SemanticColorSet {
  return semanticColors[thresholdToSemantic(value, good, poor)]
}

/** Shorthand: get hex color for a threshold value (for chart rendering) */
export function thresholdHex(value: number, good: number, poor: number): string {
  return thresholdColors(value, good, poor).hex
}
