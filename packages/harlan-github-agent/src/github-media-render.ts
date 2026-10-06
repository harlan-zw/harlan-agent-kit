import process from 'node:process'
import { Resvg } from '@resvg/resvg-js'
import { SaxesParser } from 'saxes'
import { MEDIA_LIMITS } from './github-media-limits.ts'

function parseSvg(svg: string): void {
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
    if (['image', 'feimage', 'foreignobject', 'script'].includes(name))
      reject()
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.local.toLowerCase() === 'href' && name !== 'a' && !attribute.value.startsWith('#'))
        reject()
      css(attribute.value)
    }
  })
  parser.on('text', css)
  parser.on('cdata', css)
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
  const image = new Resvg(svg, { font: { loadSystemFonts: false, fontDirs: ['/usr/share/fonts'] }, logLevel: 'off' })
  if (image.imagesToResolve().length > 0 || image.width < 1 || image.height < 1 || image.width > MEDIA_LIMITS.dimension || image.height > MEDIA_LIMITS.dimension || image.width * image.height > MEDIA_LIMITS.pixels)
    throw new Error('SVG exceeds the pixel limit or references external images.')
  const png = image.render().asPng()
  if (png.length > MEDIA_LIMITS.imageBytes)
    throw new Error('Rendered image exceeds the byte limit.')
  process.stdout.write(png)
}
main().catch((error: unknown) => {
  const known = ['SVG contains unsupported external resources.', 'SVG exceeds the pixel limit or references external images.', 'Rendered image exceeds the byte limit.', 'Image exceeds the byte limit.']
  process.stderr.write(error instanceof Error && known.includes(error.message) ? error.message : 'SVG rendering failed.')
  process.exitCode = 1
})
