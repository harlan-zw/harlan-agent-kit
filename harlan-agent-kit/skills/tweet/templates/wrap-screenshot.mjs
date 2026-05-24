/**
 * Wraps a screenshot in window chrome with a themed background.
 * Outputs at Twitter-optimal 16:9 (1600x900) with centered floating window.
 *
 * Customize the constants below before running.
 *
 * Dependencies: sharp, @resvg/resvg-js
 * Usage: node wrap-screenshot.mjs
 */
import { Resvg } from '@resvg/resvg-js'
import sharp from 'sharp'

// --- Customize these ---
const INPUT_PATH = 'img.png'
const OUTPUT_PATH = 'img-twitter.png'
const TITLE = 'claude — ~/project'
const THEME = 'midnight' // midnight | ocean | sunset | forest | lavender | ember
const CHROME = 'terminal' // terminal | browser | minimal | none
// --- End customization ---

// Twitter optimal 16:9
const TARGET_W = 1600
const TARGET_H = 900

// Layout
const PADDING = 64
const TITLE_BAR_HEIGHT = CHROME === 'none' ? 0 : CHROME === 'minimal' ? 8 : 40
const CORNER_RADIUS = 12
const TRAFFIC_LIGHT_Y = 20
const TRAFFIC_LIGHT_START_X = 20
const TRAFFIC_LIGHT_GAP = 22
const TRAFFIC_LIGHT_R = 7

// Theme definitions
const THEMES = {
  midnight: {
    bg: ['#0f0f1a', '#1a1a2e', '#16213e'],
    accent: '#4a6cf7',
    orbs: ['#4a6cf7', '#6366f1', '#818cf8'],
    windowBg: '#1e1e2e',
    titleBar: '#252535',
    titleColor: '#888899',
    border: '#333355',
  },
  ocean: {
    bg: ['#0a192f', '#0d2137', '#112240'],
    accent: '#64ffda',
    orbs: ['#64ffda', '#38bdf8', '#22d3ee'],
    windowBg: '#112240',
    titleBar: '#1a2f4e',
    titleColor: '#8892b0',
    border: '#234567',
  },
  sunset: {
    bg: ['#1a0a1e', '#2d1b35', '#1e0f28'],
    accent: '#f97316',
    orbs: ['#f97316', '#fb923c', '#f59e0b'],
    windowBg: '#1e1225',
    titleBar: '#2a1a32',
    titleColor: '#a08090',
    border: '#443355',
  },
  forest: {
    bg: ['#0a1a0f', '#0f2518', '#0d1f12'],
    accent: '#22c55e',
    orbs: ['#22c55e', '#4ade80', '#86efac'],
    windowBg: '#0f1a14',
    titleBar: '#1a2a1f',
    titleColor: '#6a9a7a',
    border: '#2a4a35',
  },
  lavender: {
    bg: ['#1a1025', '#221533', '#1e1230'],
    accent: '#a78bfa',
    orbs: ['#a78bfa', '#c4b5fd', '#8b5cf6'],
    windowBg: '#1e1530',
    titleBar: '#281e3a',
    titleColor: '#9a8aaa',
    border: '#3a2a55',
  },
  ember: {
    bg: ['#1a0a0a', '#2a1010', '#1e0808'],
    accent: '#ef4444',
    orbs: ['#ef4444', '#f87171', '#fca5a5'],
    windowBg: '#1a0f0f',
    titleBar: '#2a1a1a',
    titleColor: '#aa7777',
    border: '#4a2a2a',
  },
}

const theme = THEMES[THEME] || THEMES.midnight

// Available space for the image inside the window
const maxImgW = TARGET_W - PADDING * 2 - 2
const maxImgH = TARGET_H - PADDING * 2 - TITLE_BAR_HEIGHT

// Read and resize the image to fit
const meta = await sharp(INPUT_PATH).metadata()
const srcRatio = meta.width / meta.height
const fitRatio = maxImgW / maxImgH

let imgW, imgH
if (srcRatio > fitRatio) {
  imgW = maxImgW
  imgH = Math.round(maxImgW / srcRatio)
}
else {
  imgH = maxImgH
  imgW = Math.round(maxImgH * srcRatio)
}

const resizedBuf = await sharp(INPUT_PATH)
  .resize(imgW, imgH, { fit: 'inside' })
  .png()
  .toBuffer()
const imgB64 = resizedBuf.toString('base64')

// Window sized to image, centered on canvas
const winW = imgW + 2
const winH = imgH + TITLE_BAR_HEIGHT
const winX = Math.round((TARGET_W - winW) / 2)
const winY = Math.round((TARGET_H - winH) / 2)

function buildChrome() {
  if (CHROME === 'none') {
    return `<image x="${winX + 1}" y="${winY}" width="${imgW}" height="${imgH}" href="data:image/png;base64,${imgB64}"/>`
  }
  if (CHROME === 'minimal') {
    return `
    <rect x="${winX}" y="${winY}" width="${winW}" height="8" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}" fill="${theme.titleBar}"/>
    <image x="${winX + 1}" y="${winY + 8}" width="${imgW}" height="${imgH}" href="data:image/png;base64,${imgB64}"/>`
  }
  const trafficLights = CHROME === 'terminal'
    ? `<circle cx="${winX + TRAFFIC_LIGHT_START_X}" cy="${winY + TRAFFIC_LIGHT_Y}" r="${TRAFFIC_LIGHT_R}" fill="#ff5f57"/>
    <circle cx="${winX + TRAFFIC_LIGHT_START_X + TRAFFIC_LIGHT_GAP}" cy="${winY + TRAFFIC_LIGHT_Y}" r="${TRAFFIC_LIGHT_R}" fill="#febc2e"/>
    <circle cx="${winX + TRAFFIC_LIGHT_START_X + TRAFFIC_LIGHT_GAP * 2}" cy="${winY + TRAFFIC_LIGHT_Y}" r="${TRAFFIC_LIGHT_R}" fill="#28c840"/>`
    : `<rect x="${winX + 14}" y="${winY + 12}" width="${winW - 28}" height="16" rx="4" fill="${theme.windowBg}" opacity="0.6"/>
    <text x="${winX + winW / 2}" y="${winY + TRAFFIC_LIGHT_Y + 4}" text-anchor="middle" fill="${theme.titleColor}" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="11">${TITLE}</text>`

  return `
    <rect x="${winX}" y="${winY}" width="${winW}" height="${TITLE_BAR_HEIGHT}" fill="${theme.titleBar}"/>
    <line x1="${winX}" y1="${winY + TITLE_BAR_HEIGHT}" x2="${winX + winW}" y2="${winY + TITLE_BAR_HEIGHT}" stroke="${theme.border}" stroke-width="1"/>
    ${trafficLights}
    ${CHROME === 'terminal' ? `<text x="${winX + winW / 2}" y="${winY + TRAFFIC_LIGHT_Y + 5}" text-anchor="middle" fill="${theme.titleColor}" font-family="SF Mono, Menlo, Consolas, monospace" font-size="13">${TITLE}</text>` : ''}
    <image x="${winX + 1}" y="${winY + TITLE_BAR_HEIGHT}" width="${imgW}" height="${imgH}" href="data:image/png;base64,${imgB64}"/>`
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${TARGET_W}" height="${TARGET_H}">
  <defs>
    <radialGradient id="bgGrad" cx="50%" cy="45%" r="70%" fx="45%" fy="35%">
      <stop offset="0%" stop-color="${theme.bg[1]}"/>
      <stop offset="50%" stop-color="${theme.bg[0]}"/>
      <stop offset="100%" stop-color="${theme.bg[2]}"/>
    </radialGradient>
    <radialGradient id="orb1" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${theme.orbs[0]}" stop-opacity="0.15"/>
      <stop offset="70%" stop-color="${theme.orbs[0]}" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="${theme.orbs[0]}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="orb2" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${theme.orbs[1]}" stop-opacity="0.12"/>
      <stop offset="60%" stop-color="${theme.orbs[1]}" stop-opacity="0.03"/>
      <stop offset="100%" stop-color="${theme.orbs[1]}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="orb3" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${theme.orbs[2]}" stop-opacity="0.10"/>
      <stop offset="50%" stop-color="${theme.orbs[2]}" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="${theme.orbs[2]}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="accentLine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${theme.accent}" stop-opacity="0"/>
      <stop offset="30%" stop-color="${theme.accent}" stop-opacity="0.15"/>
      <stop offset="70%" stop-color="${theme.accent}" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="${theme.accent}" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="winClip">
      <rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}"/>
    </clipPath>
  </defs>

  <!-- Background -->
  <rect width="${TARGET_W}" height="${TARGET_H}" fill="url(#bgGrad)"/>

  <!-- Orbs -->
  <ellipse cx="${TARGET_W * 0.25}" cy="${TARGET_H * 0.2}" rx="500" ry="350" fill="url(#orb1)"/>
  <ellipse cx="${TARGET_W * 0.8}" cy="${TARGET_H * 0.75}" rx="450" ry="380" fill="url(#orb2)"/>
  <ellipse cx="${TARGET_W * 0.6}" cy="${TARGET_H * 0.1}" rx="600" ry="200" fill="url(#orb3)"/>

  <!-- Accent arcs -->
  <path d="M ${TARGET_W * 0.05} ${TARGET_H * 0.6} Q ${TARGET_W * 0.35} ${TARGET_H * 0.1}, ${TARGET_W * 0.95} ${TARGET_H * 0.3}" fill="none" stroke="${theme.accent}" stroke-width="1" stroke-opacity="0.08"/>
  <path d="M ${TARGET_W * 0.1} ${TARGET_H * 0.95} Q ${TARGET_W * 0.5} ${TARGET_H * 0.3}, ${TARGET_W * 0.9} ${TARGET_H * 0.7}" fill="none" stroke="${theme.accent}" stroke-width="0.8" stroke-opacity="0.06"/>

  <!-- Subtle grid dots -->
  <pattern id="dots" width="40" height="40" patternUnits="userSpaceOnUse">
    <circle cx="20" cy="20" r="0.5" fill="${theme.accent}" opacity="0.1"/>
  </pattern>
  <rect width="${TARGET_W}" height="${TARGET_H}" fill="url(#dots)"/>

  <!-- Window shadow -->
  <rect x="${winX + 4}" y="${winY + 6}" width="${winW}" height="${winH}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}" fill="black" opacity="0.3"/>
  <rect x="${winX + 2}" y="${winY + 3}" width="${winW}" height="${winH}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}" fill="black" opacity="0.15"/>

  <!-- Window -->
  <g clip-path="url(#winClip)">
    <rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" fill="${theme.windowBg}"/>
    ${buildChrome()}
  </g>

  <!-- Window border with accent glow -->
  <rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}" fill="none" stroke="${theme.border}" stroke-width="1"/>
  <rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}" fill="none" stroke="${theme.accent}" stroke-width="1" stroke-opacity="0.1"/>
</svg>`

const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: TARGET_W },
  font: { loadSystemFonts: true },
})

const pngBuf = resvg.render().asPng()
await sharp(pngBuf).png({ compressionLevel: 9 }).toFile(OUTPUT_PATH)
console.log(`Wrapped: ${INPUT_PATH} → ${OUTPUT_PATH} (${TARGET_W}x${TARGET_H}, image ${meta.width}x${meta.height} → ${imgW}x${imgH}, theme: ${THEME}, chrome: ${CHROME})`)
