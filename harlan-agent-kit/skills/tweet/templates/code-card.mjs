/**
 * Generates a beautiful code snippet card for Twitter.
 * Renders syntax-highlighted code in a themed window at 1600x900.
 * No screenshot input needed; generates from raw code text.
 *
 * Dependencies: sharp, @resvg/resvg-js
 * Usage: node code-card.mjs
 */
import { Resvg } from '@resvg/resvg-js'
import sharp from 'sharp'

// --- Customize these ---
const CODE = `// example code here
const result = await fetch('/api/data')
const data = await result.json()`
const LANGUAGE = 'typescript' // used for title display
const TITLE = '' // optional: overrides the language label
const THEME = 'midnight' // midnight | ocean | sunset | forest | lavender | ember
const OUTPUT_PATH = 'code-card.png'
// --- End customization ---

const TARGET_W = 1600
const TARGET_H = 900
const PADDING = 80
const TITLE_BAR_HEIGHT = 44
const CORNER_RADIUS = 12
const CODE_PADDING = 24
const LINE_HEIGHT = 26
const FONT_SIZE = 16

const THEMES = {
  midnight: {
    bg: ['#0f0f1a', '#1a1a2e', '#16213e'],
    accent: '#4a6cf7',
    orbs: ['#4a6cf7', '#6366f1', '#818cf8'],
    windowBg: '#1e1e2e',
    titleBar: '#252535',
    titleColor: '#888899',
    border: '#333355',
    code: {
      text: '#cdd6f4',
      keyword: '#cba6f7',
      string: '#a6e3a1',
      comment: '#585b70',
      function: '#89b4fa',
      number: '#fab387',
      operator: '#89dceb',
      type: '#f9e2af',
    },
  },
  ocean: {
    bg: ['#0a192f', '#0d2137', '#112240'],
    accent: '#64ffda',
    orbs: ['#64ffda', '#38bdf8', '#22d3ee'],
    windowBg: '#112240',
    titleBar: '#1a2f4e',
    titleColor: '#8892b0',
    border: '#234567',
    code: {
      text: '#ccd6f6',
      keyword: '#c792ea',
      string: '#addb67',
      comment: '#637777',
      function: '#82aaff',
      number: '#f78c6c',
      operator: '#89ddff',
      type: '#ffcb6b',
    },
  },
  sunset: {
    bg: ['#1a0a1e', '#2d1b35', '#1e0f28'],
    accent: '#f97316',
    orbs: ['#f97316', '#fb923c', '#f59e0b'],
    windowBg: '#1e1225',
    titleBar: '#2a1a32',
    titleColor: '#a08090',
    border: '#443355',
    code: {
      text: '#e0d0e0',
      keyword: '#ff79c6',
      string: '#f1fa8c',
      comment: '#6272a4',
      function: '#ffb86c',
      number: '#bd93f9',
      operator: '#ff79c6',
      type: '#8be9fd',
    },
  },
  forest: {
    bg: ['#0a1a0f', '#0f2518', '#0d1f12'],
    accent: '#22c55e',
    orbs: ['#22c55e', '#4ade80', '#86efac'],
    windowBg: '#0f1a14',
    titleBar: '#1a2a1f',
    titleColor: '#6a9a7a',
    border: '#2a4a35',
    code: {
      text: '#d0e0d4',
      keyword: '#7ee787',
      string: '#a5d6ff',
      comment: '#546e5a',
      function: '#d2a8ff',
      number: '#ffa657',
      operator: '#79c0ff',
      type: '#ffa657',
    },
  },
  lavender: {
    bg: ['#1a1025', '#221533', '#1e1230'],
    accent: '#a78bfa',
    orbs: ['#a78bfa', '#c4b5fd', '#8b5cf6'],
    windowBg: '#1e1530',
    titleBar: '#281e3a',
    titleColor: '#9a8aaa',
    border: '#3a2a55',
    code: {
      text: '#e0d8f0',
      keyword: '#c792ea',
      string: '#c3e88d',
      comment: '#676e95',
      function: '#82aaff',
      number: '#f78c6c',
      operator: '#89ddff',
      type: '#ffcb6b',
    },
  },
  ember: {
    bg: ['#1a0a0a', '#2a1010', '#1e0808'],
    accent: '#ef4444',
    orbs: ['#ef4444', '#f87171', '#fca5a5'],
    windowBg: '#1a0f0f',
    titleBar: '#2a1a1a',
    titleColor: '#aa7777',
    border: '#4a2a2a',
    code: {
      text: '#e0d0d0',
      keyword: '#ff6b6b',
      string: '#98c379',
      comment: '#5c6370',
      function: '#61afef',
      number: '#d19a66',
      operator: '#56b6c2',
      type: '#e5c07b',
    },
  },
}

const theme = THEMES[THEME] || THEMES.midnight

// Naive syntax highlighting via regex; maps tokens to theme colors
function highlightLine(line) {
  const escaped = line
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  return escaped
    // Comments
    .replace(/(\/\/.*)$/gm, `<tspan fill="${theme.code.comment}">$1</tspan>`)
    // Strings (double and single quoted, template literals)
    .replace(/(&apos;[^&apos;]*&apos;|&quot;[^&quot;]*&quot;|'[^']*'|"[^"]*"|`[^`]*`)/g, `<tspan fill="${theme.code.string}">$1</tspan>`)
    // Keywords
    .replace(/\b(const|let|var|function|return|if|else|for|while|import|export|from|async|await|class|extends|new|throw|try|catch|finally|typeof|instanceof|in|of|default|switch|case|break|continue|yield|interface|type|enum|implements|readonly|as|is|keyof|void)\b/g, `<tspan fill="${theme.code.keyword}">$1</tspan>`)
    // Numbers
    .replace(/\b(\d+(?:\.\d*)?)\b/g, `<tspan fill="${theme.code.number}">$1</tspan>`)
    // Function calls
    .replace(/(\w+)(?=\()/g, `<tspan fill="${theme.code.function}">$1</tspan>`)
    // Type annotations (PascalCase words)
    .replace(/\b([A-Z][a-zA-Z0-9]+)\b/g, `<tspan fill="${theme.code.type}">$1</tspan>`)
    // Operators
    .replace(/(=&gt;|[=!<>]=?|&&|\|\||[+\-*/%](?!=))/g, `<tspan fill="${theme.code.operator}">$1</tspan>`)
}

const lines = CODE.split('\n')
const displayTitle = TITLE || LANGUAGE

// Calculate window size based on code content
const maxLineLen = Math.max(...lines.map(l => l.length))
const codeBlockW = Math.min(Math.max(maxLineLen * (FONT_SIZE * 0.6) + CODE_PADDING * 2, 500), TARGET_W - PADDING * 2)
const codeBlockH = Math.min(lines.length * LINE_HEIGHT + CODE_PADDING * 2, TARGET_H - PADDING * 2 - TITLE_BAR_HEIGHT)
const winW = codeBlockW
const winH = codeBlockH + TITLE_BAR_HEIGHT
const winX = Math.round((TARGET_W - winW) / 2)
const winY = Math.round((TARGET_H - winH) / 2)

// Line number gutter width
const gutterW = 48
const codeStartX = winX + gutterW + CODE_PADDING

const codeLines = lines.map((line, i) => {
  const y = winY + TITLE_BAR_HEIGHT + CODE_PADDING + (i + 1) * LINE_HEIGHT
  if (y > winY + winH - 8)
    return '' // clip overflow
  const lineNum = `<text x="${winX + gutterW - 8}" y="${y}" text-anchor="end" fill="${theme.code.comment}" font-family="SF Mono, Menlo, Consolas, monospace" font-size="${FONT_SIZE - 1}">${i + 1}</text>`
  const codeTxt = `<text x="${codeStartX}" y="${y}" fill="${theme.code.text}" font-family="SF Mono, Menlo, Consolas, monospace" font-size="${FONT_SIZE}">${highlightLine(line)}</text>`
  return lineNum + codeTxt
}).join('\n    ')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${TARGET_W}" height="${TARGET_H}">
  <defs>
    <radialGradient id="bgGrad" cx="50%" cy="45%" r="70%" fx="45%" fy="35%">
      <stop offset="0%" stop-color="${theme.bg[1]}"/>
      <stop offset="50%" stop-color="${theme.bg[0]}"/>
      <stop offset="100%" stop-color="${theme.bg[2]}"/>
    </radialGradient>
    <radialGradient id="orb1" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${theme.orbs[0]}" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="${theme.orbs[0]}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="orb2" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${theme.orbs[1]}" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="${theme.orbs[1]}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="winClip">
      <rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}"/>
    </clipPath>
    <pattern id="dots" width="40" height="40" patternUnits="userSpaceOnUse">
      <circle cx="20" cy="20" r="0.5" fill="${theme.accent}" opacity="0.1"/>
    </pattern>
  </defs>

  <!-- Background -->
  <rect width="${TARGET_W}" height="${TARGET_H}" fill="url(#bgGrad)"/>
  <ellipse cx="${TARGET_W * 0.25}" cy="${TARGET_H * 0.2}" rx="500" ry="350" fill="url(#orb1)"/>
  <ellipse cx="${TARGET_W * 0.8}" cy="${TARGET_H * 0.75}" rx="450" ry="380" fill="url(#orb2)"/>
  <rect width="${TARGET_W}" height="${TARGET_H}" fill="url(#dots)"/>

  <!-- Accent arcs -->
  <path d="M ${TARGET_W * 0.05} ${TARGET_H * 0.6} Q ${TARGET_W * 0.35} ${TARGET_H * 0.1}, ${TARGET_W * 0.95} ${TARGET_H * 0.3}" fill="none" stroke="${theme.accent}" stroke-width="1" stroke-opacity="0.08"/>

  <!-- Window shadow -->
  <rect x="${winX + 4}" y="${winY + 6}" width="${winW}" height="${winH}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}" fill="black" opacity="0.3"/>

  <!-- Window -->
  <g clip-path="url(#winClip)">
    <rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" fill="${theme.windowBg}"/>
    <rect x="${winX}" y="${winY}" width="${winW}" height="${TITLE_BAR_HEIGHT}" fill="${theme.titleBar}"/>
    <line x1="${winX}" y1="${winY + TITLE_BAR_HEIGHT}" x2="${winX + winW}" y2="${winY + TITLE_BAR_HEIGHT}" stroke="${theme.border}" stroke-width="1"/>

    <!-- Traffic lights -->
    <circle cx="${winX + 20}" cy="${winY + 22}" r="7" fill="#ff5f57"/>
    <circle cx="${winX + 42}" cy="${winY + 22}" r="7" fill="#febc2e"/>
    <circle cx="${winX + 64}" cy="${winY + 22}" r="7" fill="#28c840"/>

    <!-- Title -->
    <text x="${winX + winW / 2}" y="${winY + 27}" text-anchor="middle" fill="${theme.titleColor}" font-family="SF Mono, Menlo, Consolas, monospace" font-size="13">${displayTitle}</text>

    <!-- Gutter separator -->
    <line x1="${winX + gutterW}" y1="${winY + TITLE_BAR_HEIGHT}" x2="${winX + gutterW}" y2="${winY + winH}" stroke="${theme.border}" stroke-width="1" opacity="0.4"/>

    <!-- Code lines -->
    ${codeLines}
  </g>

  <!-- Window border -->
  <rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}" fill="none" stroke="${theme.border}" stroke-width="1"/>
  <rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}" fill="none" stroke="${theme.accent}" stroke-width="1" stroke-opacity="0.1"/>
</svg>`

const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: TARGET_W },
  font: { loadSystemFonts: true },
})

const pngBuf = resvg.render().asPng()
await sharp(pngBuf).png({ compressionLevel: 9 }).toFile(OUTPUT_PATH)
console.log(`Code card: ${OUTPUT_PATH} (${TARGET_W}x${TARGET_H}, ${lines.length} lines, theme: ${THEME})`)
