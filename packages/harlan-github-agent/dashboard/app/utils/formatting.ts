import { semanticColors } from './semantic-colors.ts'

/**
 * Number and time formatting, ported from the nuxtseo design system.
 *
 * `Intl.*` constructors are expensive; hoist to module scope so per-cell
 * formatters across large tables reuse one instance. The app is English-only,
 * so display formatting is pinned to one locale: letting Node and the browser
 * choose independently produced different compact suffixes (`1.2K` during SSR,
 * `1.2k` in Chrome) and guaranteed hydration mismatches.
 */
const DISPLAY_LOCALE = 'en-US'
const compactNumberFormat = new Intl.NumberFormat(DISPLAY_LOCALE, { notation: 'compact', maximumFractionDigits: 1 })
const groupedNumberFormat = new Intl.NumberFormat(DISPLAY_LOCALE)
const relativeTimeFormat = new Intl.RelativeTimeFormat(DISPLAY_LOCALE, { numeric: 'auto', style: 'narrow' })
const signedPercentFormat = new Intl.NumberFormat(DISPLAY_LOCALE, { style: 'percent', signDisplay: 'exceptZero', minimumFractionDigits: 1, maximumFractionDigits: 1 })

/**
 * Pure trend percentage between two values.
 * For metrics where lower is better, pass `invert: true`.
 * Returns 0 when prev is 0/null/undefined to avoid Infinity.
 */
export function calcTrendPercent(current: number, prev: number, invert = false): number {
  if (!prev)
    return 0
  const pct = Math.round(((current - prev) / prev) * 100) || 0
  return (invert ? -pct : pct) || 0
}

/**
 * Compact K/M display for a stat that may arrive as a string. The nuxtseo
 * version also accepted a ref; this app's utils stay framework free so the
 * unit tests can import them, so pass the value and format inside a `computed` yourself.
 */
export function humanFriendlyNumber(number: string | number | null | undefined, decimals?: number): string {
  if (!['number', 'string'].includes(typeof number))
    return '-'
  let value = Number(number)
  if (typeof decimals !== 'undefined')
    value = Number.parseFloat(value.toFixed(decimals))
  return compactNumberFormat.format(value)
}

export function formatTimeAgo(timestamp: number | string | Date | null | undefined): string | null {
  if (!timestamp)
    return null
  // A raw `number` may be unix SECONDS or unix MILLISECONDS. Disambiguate by
  // magnitude: seconds for any plausible date are < 1e11, ms are ≥ 1e12.
  const date = typeof timestamp === 'number'
    ? new Date(timestamp < 1e11 ? timestamp * 1000 : timestamp)
    : new Date(timestamp)
  // Signed distance, so a FUTURE date reads forward ("in 6 days").
  const diff = Date.now() - date.getTime()
  const ahead = diff < 0
  const distance = Math.abs(diff)
  const minutes = Math.floor(distance / 60000)
  const hours = Math.floor(distance / 3600000)
  const days = Math.floor(distance / 86400000)
  const signed = (n: number): number => ahead ? n : -n
  if (minutes < 1)
    return 'just now'
  if (minutes < 60)
    return relativeTimeFormat.format(signed(minutes), 'minute')
  if (hours < 24)
    return relativeTimeFormat.format(signed(hours), 'hour')
  if (days < 30)
    return relativeTimeFormat.format(signed(days), 'day')
  const months = Math.floor(days / 30)
  if (months < 12)
    return relativeTimeFormat.format(signed(months), 'month')
  return relativeTimeFormat.format(signed(Math.floor(days / 365)), 'year')
}

/** Compact: 1234 reads as 1.2K. A missing value reads as a dash. */
export function formatNumber(n: number | null | undefined): string {
  if (n == null)
    return '–'
  return compactNumberFormat.format(n)
}

/** Grouped and exact: 1,234. For a table where every digit matters. */
export function formatExactNumber(n: number | null | undefined): string {
  if (n == null)
    return '–'
  return groupedNumberFormat.format(n)
}

// `n` is a percentage-point value (e.g. 5 → "+5.0%"), so divide before the
// percent formatter (which multiplies by 100).
export function formatPercent(n: number): string {
  return signedPercentFormat.format(n / 100)
}

export function trendColor(change: number | null): string {
  if (!change)
    return semanticColors.neutral.hex
  return change > 0 ? semanticColors.success.hex : semanticColors.error.hex
}

// --- Reporting-day buckets (daily rows keyed "YYYY-MM-DD") ---
// These are calendar-day LABELS, not instants. Parse in a fixed UTC frame so the
// round-trip is identity, and ALWAYS format with `timeZone: 'UTC'` so the label
// never drifts per viewer.
const reportingDayFormat = new Intl.DateTimeFormat(DISPLAY_LOCALE, { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** Parse a "YYYY-MM-DD" reporting-day label into a stable, viewer-independent Date. */
export function parseReportingDay(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`)
}

/** Format a "YYYY-MM-DD" reporting-day label. Defaults to "Jun 24". */
export function formatReportingDay(iso: string | null | undefined, opts?: Intl.DateTimeFormatOptions): string {
  if (!iso)
    return '–'
  if (opts)
    return new Intl.DateTimeFormat(DISPLAY_LOCALE, { ...opts, timeZone: 'UTC' }).format(parseReportingDay(iso))
  return reportingDayFormat.format(parseReportingDay(iso))
}
