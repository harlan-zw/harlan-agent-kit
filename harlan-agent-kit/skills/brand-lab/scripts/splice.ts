// Splices subagent variant snippets into a brand lab page.
// Each `variant-<piece><letter>.html` lands before `<!-- slots:<piece> -->`, wrapped in markers,
// so a rerun replaces the earlier copy in place. Pure core first, effectful shell at the bottom.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export interface Variant {
  id: string
  html: string
  author: string
}

export type Outcome
  = | { _tag: 'Added', id: string }
    | { _tag: 'Replaced', id: string }
    | { _tag: 'NoSlot', id: string, slot: string }
    | { _tag: 'UnclosedMarker', id: string }

const VARIANT_FILE = /^variant-(\d+)([A-Z])\.html$/

function tagAuthor(variant: Variant): string {
  const heading = new RegExp(`(<span class="vid">\\s*${variant.id}\\s*</span>\\s*<h3>[^<]*</h3>)`)
  return variant.html.replace(heading, `$1<span class="by">${variant.author}</span>`)
}

export function spliceVariants(page: string, variants: Variant[]): { page: string, outcomes: Outcome[] } {
  let html = page
  const outcomes: Outcome[] = []
  const ordered = [...variants].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
  for (const variant of ordered) {
    const { id } = variant
    const open = `<!-- variant:${id} -->`
    const close = `<!-- /variant:${id} -->`
    const block = `${open}\n${tagAuthor(variant)}\n${close}`
    const start = html.indexOf(open)
    if (start >= 0) {
      const end = html.indexOf(close, start)
      if (end < 0) {
        outcomes.push({ _tag: 'UnclosedMarker', id })
        continue
      }
      html = `${html.slice(0, start)}${block}${html.slice(end + close.length)}`
      outcomes.push({ _tag: 'Replaced', id })
      continue
    }
    const slot = `<!-- slots:${id.slice(0, -1)} -->`
    const at = html.indexOf(slot)
    if (at < 0) {
      outcomes.push({ _tag: 'NoSlot', id, slot })
      continue
    }
    html = `${html.slice(0, at)}${block}\n${html.slice(at)}`
    outcomes.push({ _tag: 'Added', id })
  }
  return { page: html, outcomes }
}

/** Collects rule selectors and keyframes names from every <style> block, skipping keyframe steps. */
function cssNames(html: string): { selectors: string[], keyframes: string[] } {
  const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)]
    .map(match => match[1])
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors: string[] = []
  const keyframes: string[] = []
  let depth = 0
  let keyframesDepth = -1
  let prelude = ''
  for (const char of css) {
    if (char === '{') {
      const head = prelude.trim()
      if (keyframesDepth < 0 && head.startsWith('@keyframes')) {
        keyframes.push(head.replace('@keyframes', '').trim())
        keyframesDepth = depth
      }
      else if (keyframesDepth < 0 && !head.startsWith('@')) {
        selectors.push(...head.split(',').map(selector => selector.trim()))
      }
      depth++
      prelude = ''
    }
    else if (char === '}') {
      depth--
      if (depth === keyframesDepth)
        keyframesDepth = -1
      prelude = ''
    }
    else if (char === ';') {
      prelude = ''
    }
    else {
      prelude += char
    }
  }
  return { selectors, keyframes }
}

/** Lists the snippet contract breaks that would otherwise leak into other cards. */
export function contractWarnings(variant: Variant): string[] {
  const id = variant.id
  const lower = id.toLowerCase()
  const warnings: string[] = []
  if (!variant.html.includes(`<article class="card" id="v${lower}"`))
    warnings.push(`${id}: add <article class="card" id="v${lower}">.`)
  if (!new RegExp(`<span class="vid">\\s*${id}\\s*</span>\\s*<h3>`).test(variant.html))
    warnings.push(`${id}: add <span class="vid">${id}</span><h3>, or the author tag has no anchor.`)
  const { selectors, keyframes } = cssNames(variant.html)
  for (const selector of selectors) {
    if (!selector.startsWith(`.v${lower}-`) && !selector.startsWith(`#v${lower}`))
      warnings.push(`${id}: prefix the selector "${selector}" with .v${lower}-.`)
  }
  for (const name of keyframes) {
    if (!name.startsWith(`v${lower}-`))
      warnings.push(`${id}: prefix the keyframes name "${name}" with v${lower}-.`)
  }
  return warnings
}

const USAGE = 'Usage: splice.ts <page.html> <variant-dir> [--by <ID>=<author>]...'

type Args
  = | { _tag: 'Ok', pagePath: string, dir: string, authors: Map<string, string> }
    | { _tag: 'Err', message: string }

function parseArgs(argv: string[]): Args {
  const [pagePath, dir, ...rest] = argv
  if (!pagePath || !dir)
    return { _tag: 'Err', message: USAGE }
  const authors = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 2) {
    const [id, author] = rest[i + 1]?.split('=') ?? []
    if (rest[i] !== '--by' || !id || !author)
      return { _tag: 'Err', message: `Expected --by <ID>=<author>. ${USAGE}` }
    authors.set(id, author)
  }
  return { _tag: 'Ok', pagePath, dir, authors }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2))
  if (args._tag === 'Err') {
    console.error(args.message)
    process.exit(2)
  }
  const { pagePath, dir, authors } = args
  const variants = readdirSync(dir).flatMap((name) => {
    const match = VARIANT_FILE.exec(name)
    if (!match)
      return []
    const id = `${match[1]}${match[2]}`
    return [{ id, html: readFileSync(join(dir, name), 'utf8').trim(), author: authors.get(id) ?? 'subagent' }]
  })
  const result = spliceVariants(readFileSync(pagePath, 'utf8'), variants)
  for (const outcome of result.outcomes) {
    if (outcome._tag === 'NoSlot')
      console.error(`${outcome.id}: the page has no ${outcome.slot} comment. Add it at the end of that section's grid.`)
    else if (outcome._tag === 'UnclosedMarker')
      console.error(`${outcome.id}: the page has an opening variant marker with no closing marker.`)
    else
      console.log(`${outcome._tag.toLowerCase()} ${outcome.id}`)
  }
  for (const warning of variants.flatMap(contractWarnings))
    console.warn(warning)
  writeFileSync(pagePath, result.page)
  if (result.outcomes.some(outcome => outcome._tag === 'NoSlot' || outcome._tag === 'UnclosedMarker'))
    process.exitCode = 1
}
