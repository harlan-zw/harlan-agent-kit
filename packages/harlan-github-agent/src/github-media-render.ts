import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import process from 'node:process'
import { Resvg } from '@resvg/resvg-js'
import { SaxesParser } from 'saxes'
import { MEDIA_LIMITS } from './github-media-limits.ts'

const require = createRequire(import.meta.url)
const fontFiles = [
  require.resolve('@expo-google-fonts/noto-emoji/400Regular/NotoEmoji_400Regular.ttf'),
  require.resolve('@fontpkg/unifont/unifont-15.0.01.ttf'),
]

// Both pinned fonts contain a full-repertoire Unicode cmap (format 12).
// Read only those trusted files; never inspect a host font directory.
function fontCoverage(font: Buffer): (codepoint: number) => boolean {
  let cmap = 0
  for (let index = 0; index < font.readUInt16BE(4); index++) {
    const record = 12 + index * 16
    if (font.toString('ascii', record, record + 4) === 'cmap')
      cmap = font.readUInt32BE(record + 8)
  }
  if (!cmap)
    throw new Error('Bundled font has no Unicode cmap.')
  for (let index = 0; index < font.readUInt16BE(cmap + 2); index++) {
    const record = cmap + 4 + index * 8
    const platform = font.readUInt16BE(record)
    const encoding = font.readUInt16BE(record + 2)
    if (platform !== 0 && !(platform === 3 && encoding === 10))
      continue
    const table = cmap + font.readUInt32BE(record + 4)
    if (font.readUInt16BE(table) !== 12)
      continue
    const length = font.readUInt32BE(table + 4)
    const groups = font.readUInt32BE(table + 12)
    if (length < 16 || table + length > font.length || groups > (length - 16) / 12)
      throw new Error('Bundled font has an invalid Unicode cmap.')
    return (codepoint) => {
      let low = 0
      let high = groups - 1
      while (low <= high) {
        const middle = (low + high) >>> 1
        const group = table + 16 + middle * 12
        const start = font.readUInt32BE(group)
        const end = font.readUInt32BE(group + 4)
        if (codepoint < start)
          high = middle - 1
        else if (codepoint > end)
          low = middle + 1
        else
          return font.readUInt32BE(group + 8) + codepoint - start !== 0
      }
      return false
    }
  }
  throw new Error('Bundled font has no full-repertoire Unicode cmap.')
}
const coverage = fontFiles.map(file => fontCoverage(readFileSync(file)))

function parseSvg(svg: string): void {
  const elements: string[] = []
  const checked = new Set<number>()
  const reject = () => {
    throw new Error('SVG contains unsupported external resources.')
  }
  const css = (value: string) => {
    if (/@import|\\/i.test(value))
      reject()
    for (const match of value.matchAll(/url\(([^)]*)\)/gi)) {
      if (!match[1]?.trim().replace(/^["']|["']$/g, '').startsWith('#'))
        reject()
    }
  }
  const parser = new SaxesParser({ xmlns: true })
  parser.on('doctype', reject)
  parser.on('error', reject)
  parser.on('opentag', (tag) => {
    const name = tag.local.toLowerCase()
    elements.push(name)
    if (['image', 'feimage', 'foreignobject', 'script'].includes(name))
      reject()
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.local.toLowerCase() === 'href' && name !== 'a' && !attribute.value.startsWith('#'))
        reject()
      css(attribute.value)
    }
  })
  parser.on('closetag', () => elements.pop())
  const text = (value: string) => {
    css(value)
    if (!elements.includes('text') || elements.some(name => ['title', 'desc', 'metadata', 'style'].includes(name)))
      return
    for (const character of value) {
      // Shaping controls and whitespace need no visible standalone glyph.
      if (/^[\p{White_Space}\p{Default_Ignorable_Code_Point}]$/u.test(character))
        continue
      const codepoint = character.codePointAt(0)!
      if (checked.has(codepoint))
        continue
      if (!coverage.some(covers => covers(codepoint)))
        throw new Error('SVG text contains characters unavailable in the bundled fonts.')
      checked.add(codepoint)
    }
  }
  // Saxes decodes character references and reports CDATA through the same guard.
  parser.on('text', text)
  parser.on('cdata', text)
  parser.write(svg).close()
}

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MEDIA_LIMITS.imageBytes)
      throw new Error('Image exceeds the byte limit.')
    chunks.push(bytes)
  }
  const bytes = Buffer.concat(chunks)
  const svg = bytes.toString('utf8')
  // Parse before native rendering: Resvg's default image resolver reads local files.
  parseSvg(svg)
  const image = new Resvg(svg, { font: { loadSystemFonts: false, fontFiles, defaultFontFamily: 'Noto Emoji' }, logLevel: 'off' })
  if (image.imagesToResolve().length > 0 || image.width < 1 || image.height < 1 || image.width > MEDIA_LIMITS.dimension || image.height > MEDIA_LIMITS.dimension || image.width * image.height > MEDIA_LIMITS.pixels)
    throw new Error('SVG exceeds the pixel limit or references external images.')
  const png = image.render().asPng()
  if (png.length > MEDIA_LIMITS.imageBytes)
    throw new Error('Rendered image exceeds the byte limit.')
  process.stdout.write(png)
}
main().catch((error: unknown) => {
  const known = ['SVG text contains characters unavailable in the bundled fonts.', 'SVG contains unsupported external resources.', 'SVG exceeds the pixel limit or references external images.', 'Rendered image exceeds the byte limit.', 'Image exceeds the byte limit.']
  process.stderr.write(error instanceof Error && known.includes(error.message) ? error.message : 'SVG rendering failed.')
  process.exitCode = 1
})
