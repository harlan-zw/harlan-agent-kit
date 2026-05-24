/**
 * Generates a stats/milestone card for Twitter.
 * Shows key metrics in a visually striking layout at 1600x900.
 * Great for release announcements, milestone celebrations, benchmarks.
 *
 * Dependencies: sharp, @resvg/resvg-js
 * Usage: node stat-card.mjs
 */
import { Resvg } from '@resvg/resvg-js'
import sharp from 'sharp'

// --- Customize these ---
const HEADLINE = 'Nuxt SEO v3'
const SUBHEADLINE = 'The complete SEO solution for Nuxt'
const STATS = [
  { label: 'GitHub Stars', value: '1,200+' },
  { label: 'Weekly Downloads', value: '45k' },
  { label: 'Modules Included', value: '6' },
]
const THEME = 'midnight' // midnight | ocean | sunset | forest | lavender | ember
const OUTPUT_PATH = 'stat-card.png'
// --- End customization ---

const TARGET_W = 1600
const TARGET_H = 900

const THEMES = {
  midnight: {
    bg: ['#0f0f1a', '#1a1a2e', '#16213e'],
    accent: '#4a6cf7',
    orbs: ['#4a6cf7', '#6366f1', '#818cf8'],
    text: '#e2e8f0',
    subtext: '#94a3b8',
    cardBg: '#1e1e2e',
    border: '#333355',
    statValue: '#ffffff',
    statLabel: '#94a3b8',
  },
  ocean: {
    bg: ['#0a192f', '#0d2137', '#112240'],
    accent: '#64ffda',
    orbs: ['#64ffda', '#38bdf8', '#22d3ee'],
    text: '#ccd6f6',
    subtext: '#8892b0',
    cardBg: '#112240',
    border: '#234567',
    statValue: '#e6f1ff',
    statLabel: '#8892b0',
  },
  sunset: {
    bg: ['#1a0a1e', '#2d1b35', '#1e0f28'],
    accent: '#f97316',
    orbs: ['#f97316', '#fb923c', '#f59e0b'],
    text: '#f0e0f0',
    subtext: '#a08090',
    cardBg: '#1e1225',
    border: '#443355',
    statValue: '#fff0e0',
    statLabel: '#a08090',
  },
  forest: {
    bg: ['#0a1a0f', '#0f2518', '#0d1f12'],
    accent: '#22c55e',
    orbs: ['#22c55e', '#4ade80', '#86efac'],
    text: '#d0e0d4',
    subtext: '#6a9a7a',
    cardBg: '#0f1a14',
    border: '#2a4a35',
    statValue: '#e0f0e4',
    statLabel: '#6a9a7a',
  },
  lavender: {
    bg: ['#1a1025', '#221533', '#1e1230'],
    accent: '#a78bfa',
    orbs: ['#a78bfa', '#c4b5fd', '#8b5cf6'],
    text: '#e0d8f0',
    subtext: '#9a8aaa',
    cardBg: '#1e1530',
    border: '#3a2a55',
    statValue: '#f0e8ff',
    statLabel: '#9a8aaa',
  },
  ember: {
    bg: ['#1a0a0a', '#2a1010', '#1e0808'],
    accent: '#ef4444',
    orbs: ['#ef4444', '#f87171', '#fca5a5'],
    text: '#e0d0d0',
    subtext: '#aa7777',
    cardBg: '#1a0f0f',
    border: '#4a2a2a',
    statValue: '#ffe0e0',
    statLabel: '#aa7777',
  },
}

const theme = THEMES[THEME] || THEMES.midnight

// Layout calculations
const cardW = 1000
const cardH = 400
const cardX = (TARGET_W - cardW) / 2
const cardY = (TARGET_H - cardH) / 2 + 40 // offset down for headline
const headlineY = cardY - 80
const subheadlineY = headlineY + 40
const statBlockW = cardW / STATS.length

const statBlocks = STATS.map((stat, i) => {
  const cx = cardX + statBlockW * i + statBlockW / 2
  const valueY = cardY + cardH / 2 - 10
  const labelY = valueY + 50
  const separator = i < STATS.length - 1
    ? `<line x1="${cardX + statBlockW * (i + 1)}" y1="${cardY + 60}" x2="${cardX + statBlockW * (i + 1)}" y2="${cardY + cardH - 60}" stroke="${theme.border}" stroke-width="1" opacity="0.5"/>`
    : ''

  return `
    <text x="${cx}" y="${valueY}" text-anchor="middle" fill="${theme.statValue}" font-family="-apple-system, BlinkMacSystemFont, Inter, sans-serif" font-size="64" font-weight="700">${stat.value}</text>
    <text x="${cx}" y="${labelY}" text-anchor="middle" fill="${theme.statLabel}" font-family="-apple-system, BlinkMacSystemFont, Inter, sans-serif" font-size="18" font-weight="400" letter-spacing="1">${stat.label.toUpperCase()}</text>
    ${separator}`
}).join('\n    ')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${TARGET_W}" height="${TARGET_H}">
  <defs>
    <radialGradient id="bgGrad" cx="50%" cy="45%" r="70%" fx="45%" fy="35%">
      <stop offset="0%" stop-color="${theme.bg[1]}"/>
      <stop offset="50%" stop-color="${theme.bg[0]}"/>
      <stop offset="100%" stop-color="${theme.bg[2]}"/>
    </radialGradient>
    <radialGradient id="orb1" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${theme.orbs[0]}" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="${theme.orbs[0]}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="orb2" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${theme.orbs[1]}" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="${theme.orbs[1]}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="accentGlow" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${theme.accent}" stop-opacity="0"/>
      <stop offset="50%" stop-color="${theme.accent}" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="${theme.accent}" stop-opacity="0"/>
    </linearGradient>
    <pattern id="dots" width="40" height="40" patternUnits="userSpaceOnUse">
      <circle cx="20" cy="20" r="0.5" fill="${theme.accent}" opacity="0.08"/>
    </pattern>
  </defs>

  <!-- Background -->
  <rect width="${TARGET_W}" height="${TARGET_H}" fill="url(#bgGrad)"/>
  <ellipse cx="${TARGET_W * 0.2}" cy="${TARGET_H * 0.3}" rx="500" ry="350" fill="url(#orb1)"/>
  <ellipse cx="${TARGET_W * 0.85}" cy="${TARGET_H * 0.7}" rx="450" ry="380" fill="url(#orb2)"/>
  <rect width="${TARGET_W}" height="${TARGET_H}" fill="url(#dots)"/>

  <!-- Accent arcs -->
  <path d="M ${TARGET_W * 0.05} ${TARGET_H * 0.7} Q ${TARGET_W * 0.4} ${TARGET_H * 0.05}, ${TARGET_W * 0.95} ${TARGET_H * 0.4}" fill="none" stroke="${theme.accent}" stroke-width="1.5" stroke-opacity="0.06"/>

  <!-- Headline -->
  <text x="${TARGET_W / 2}" y="${headlineY}" text-anchor="middle" fill="${theme.text}" font-family="-apple-system, BlinkMacSystemFont, Inter, sans-serif" font-size="48" font-weight="700" letter-spacing="-1">${HEADLINE}</text>
  <text x="${TARGET_W / 2}" y="${subheadlineY}" text-anchor="middle" fill="${theme.subtext}" font-family="-apple-system, BlinkMacSystemFont, Inter, sans-serif" font-size="20" font-weight="400">${SUBHEADLINE}</text>

  <!-- Accent line under headline -->
  <rect x="${(TARGET_W - 120) / 2}" y="${subheadlineY + 20}" width="120" height="2" rx="1" fill="url(#accentGlow)"/>

  <!-- Stats card shadow -->
  <rect x="${cardX + 4}" y="${cardY + 6}" width="${cardW}" height="${cardH}" rx="16" fill="black" opacity="0.25"/>

  <!-- Stats card -->
  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="16" fill="${theme.cardBg}" opacity="0.8"/>
  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="16" fill="none" stroke="${theme.border}" stroke-width="1"/>
  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="16" fill="none" stroke="${theme.accent}" stroke-width="1" stroke-opacity="0.08"/>

  <!-- Stat blocks -->
  ${statBlocks}
</svg>`

const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: TARGET_W },
  font: { loadSystemFonts: true },
})

const pngBuf = resvg.render().asPng()
await sharp(pngBuf).png({ compressionLevel: 9 }).toFile(OUTPUT_PATH)
console.log(`Stat card: ${OUTPUT_PATH} (${TARGET_W}x${TARGET_H}, ${STATS.length} stats, theme: ${THEME})`)
