import type { JournalStore } from './store.ts'
import { Buffer } from 'node:buffer'
import { basename, dirname, isAbsolute, normalize } from 'node:path'
import { decodeHTML } from 'entities'

/**
 * Private details that no public body may carry.
 *
 * Built once from configuration and the host, never from a blanket pattern.
 * A finding may describe `localhost` or an absolute controller configuration
 * path. Home-relative paths can name worker data, so worker aliases count too.
 */
export interface PrivateDetails {
  /** Directory prefixes, absolute, `~/`, or `$HOME/`. A path at or under one is private. */
  paths: readonly string[]
  /** Host names. A link to one, or to a subdomain of one, is private. */
  hosts: readonly string[]
}

/** The roots and hosts this host and configuration use. */
export interface PrivateDetailSources {
  /** The controller home. Only the roots under it are private, never the home itself. */
  home: string
  /** The Journal path. Its directory holds the controller worktrees and desktop turns. */
  storagePath: string
  /** Trusted checkout roots, where Worktrunk places every Agent worktree. */
  checkoutRoots: readonly string[]
  /** The Agent worker home inside the sandbox and on the host. */
  workerHomes: readonly string[]
  /** The dashboard origins, which name the Service's own hosts. */
  serviceOrigins: readonly string[]
}

/** Directories under the controller home that hold private notes and scratch evidence. */
const PRIVATE_HOME_DIRECTORIES = ['scratch', 'notes'] as const

/** Harlan's local notes viewer. It is not in the configuration, so it is named here. */
const NOTES_HOST = 'notes.localhost'

/**
 * The local dashboard host. Every host runs a dashboard here, so an Agent turn
 * from another host can name it even when this host's origin is a Tailscale one.
 */
export const DASHBOARD_LOCAL_HOST = 'harlan-github-agent.localhost'

/** Loopback names a finding may describe. They never name a private host on their own. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Top-level directories every Linux host shares. Denying one would remove
 * ordinary lines, so a root equal to one of these never counts. A dedicated
 * top-level root such as `/worker-data` does.
 */
const SHARED_ROOTS = new Set(['/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/media', '/mnt', '/opt', '/proc', '/root', '/run', '/sbin', '/snap', '/srv', '/sys', '/tmp', '/usr', '/var'])

function privateRoot(path: string): string | null {
  if (!isAbsolute(path))
    return null
  const root = normalize(path).replace(/\/+$/, '')
  return root === '' || SHARED_ROOTS.has(root) ? null : root
}

/** Every way a body can spell one root: absolute, and from the home directory when it sits there. */
function spellings(root: string, home: string | null): string[] {
  if (home === null || (root !== home && !root.startsWith(`${home}/`)))
    return [root]
  if (root === home)
    return [root, '~/', `~${basename(home)}/`, '$HOME/', `\${HOME}/`]
  const rest = root.slice(home.length + 1)
  return [root, `~/${rest}`, `~${basename(home)}/${rest}`, `$HOME/${rest}`, `\${HOME}/${rest}`]
}

export function privateDetailsFor(sources: PrivateDetailSources): PrivateDetails {
  // The home is a prefix, never a denied root, so a one-segment home such as /root still counts.
  const home = isAbsolute(sources.home) && normalize(sources.home) !== '/' ? normalize(sources.home).replace(/\/+$/, '') : null
  const roots = [
    dirname(sources.storagePath),
    ...sources.checkoutRoots,
    ...sources.workerHomes,
    ...(home === null ? [] : PRIVATE_HOME_DIRECTORIES.map(name => `${home}/${name}`)),
  ].flatMap(path => privateRoot(path) ?? [])
  const hosts = sources.serviceOrigins.flatMap((origin) => {
    if (!URL.canParse(origin))
      return []
    const host = new URL(origin).hostname.toLowerCase()
    return LOOPBACK_HOSTS.has(host) ? [] : [host]
  })
  return {
    // Workers report paths relative to their own HOME. Protect that entire home,
    // while controller aliases still cover only its configured private roots.
    paths: [...new Set([
      ...roots.flatMap(root => spellings(root, home)),
      ...sources.workerHomes.flatMap((path) => {
        const root = privateRoot(path)
        return root === null ? [] : spellings(root, root)
      }),
    ])],
    hosts: [...new Set([NOTES_HOST, DASHBOARD_LOCAL_HOST, ...hosts])],
  }
}

/**
 * The characters the native review writes as numeric entities.
 *
 * Detection decodes all Markdown entities, including characters outside this list.
 */
const ENTITY_ENCODED_CHARACTERS = '&<>@[]#`*_~'

export function encodeEntities(value: string): string {
  return [...value].map(character => ENTITY_ENCODED_CHARACTERS.includes(character) ? `&#${character.charCodeAt(0)};` : character).join('')
}

/** One private detail a body carried, named by the deny list entry it matched. */
export interface PrivateDetailHit {
  _tag: 'Path' | 'Link'
  entry: string
}

export interface Redaction {
  text: string
  hits: PrivateDetailHit[]
}

/**
 * The text that replaces any line naming a private detail.
 *
 * The guard removes whole lines, never single tokens. Every attempt to cut out
 * only the private token left a fragment behind: a suffix after a parenthesis,
 * credentials before an at sign, or the tail of a Markdown destination.
 */
export const REMOVED_LINE = '_One line removed: it named a private path or host._'

/**
 * What a removed line keeps: indentation, blockquote markers, and one list or
 * checkbox marker. None of these holds text, and Markdown structure relies on
 * them. The one word kept is `Repair:`, because the Logged finding status
 * parser reads it. Any other label is free text and goes with the line.
 */
const LINE_STRUCTURE = /^[ \t]*(?:>[ \t]?)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?(?:Repair:[ \t]+)?/
/**
 * The HTML comment markers on one line, in one forward scan. An opener with
 * no closer ends the scan, so a line of unclosed openers costs linear time.
 */
function htmlComments(line: string): string[] {
  const comments: string[] = []
  let from = 0
  for (;;) {
    const open = line.indexOf('<!--', from)
    const close = open === -1 ? -1 : line.indexOf('-->', open + 4)
    if (close === -1)
      return comments
    comments.push(line.slice(open, close + 3))
    from = close + 3
  }
}

function escape(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Where an entry ends. A full stop that ends the sentence counts, so
 * `~/scratch.` matches, while `~/scratchpad` and `~/scratch.txt` do not.
 */
const ENTRY_END = String.raw`(?![\w-]|\.[\w-])`
/** In the raw view, an entity right after an entry leaves the decision to the decoded view. */
const RAW_ENTRY_END = String.raw`(?![\w-]|\.[\w-]|&#?\w+;)`
/** Where a host ends. A host name holds no underscore, so `__host__` emphasis still matches. */
const HOST_END = String.raw`(?![a-z\d-]|\.[a-z\d-])`
/**
 * A URL authority: any scheme, or none, then `//`. A host after it is the
 * URL's own host and is private. A bare host after a single slash is a path
 * segment of some other URL, so it stays.
 */
const AUTHORITY = String.raw`(?:(?<![\w.+-])[a-z][a-z\d+.-]{0,15}:)?(?<![\w./-])//`

/** Markdown emphasis, strikethrough, code span, and quote characters. They render as nothing, or as plain punctuation. */
const FORMATTING = /~~|[*_`"']/g

interface Detector {
  /** Each spelling the patterns match, to the deny list entry it stands for. */
  entries: Map<string, string>
  hosts: Map<string, string>
  path: RegExp | null
  link: RegExp | null
}

/**
 * One detector per view. The normalised view lost its formatting characters,
 * so it matches entries that lost theirs too: `/srv/agent_home` there reads
 * `/srv/agenthome`.
 *
 * Every pattern starts from a literal deny list entry, and every repetition is
 * bounded, so one scan does bounded work per character of the body.
 */
/** A path entry must start a token: `/srv/agent_home` is not `/home`. */
const TOKEN_START = String.raw`(?<![\w.~$-])`

function detector(details: PrivateDetails, spell: (entry: string) => string, end: string, start = TOKEN_START): Detector {
  const entries = new Map(details.paths.map(entry => [spell(entry), entry]))
  const hosts = new Map(details.hosts.map(host => [spell(host).toLowerCase(), host]))
  const longestFirst = (values: Iterable<string>) => [...values].filter(Boolean).sort((left, right) => right.length - left.length).map(escape)
  // A spelling ending in a slash already marks the directory boundary.
  const paths = [...entries.keys()].filter(Boolean).sort((left, right) => right.length - left.length).map(path => `${escape(path)}${path.endsWith('/') ? '' : end}`)
  const names = longestFirst(hosts.keys())
  return {
    entries,
    hosts,
    path: paths.length === 0 ? null : new RegExp(String.raw`${start}(?:${paths.join('|')})`, 'g'),
    // User information before an at sign is part of the line, so it goes with it.
    link: names.length === 0 ? null : new RegExp(String.raw`(?:${AUTHORITY}|(?<![\w./-]))(?:[\w-]{1,63}\.){0,8}(?:${names.join('|')})${HOST_END}`, 'gi'),
  }
}

function entryFor(detect: Detector, hit: PrivateDetailHit['_tag'], matched: string): string {
  if (hit === 'Path')
    return detect.entries.get(matched) ?? matched
  const host = matched.replace(/^(?:[a-z][a-z\d+.-]*:)?\/\//i, '').toLowerCase()
  const entry = [...detect.hosts.keys()].find(name => host === name || host.endsWith(`.${name}`))
  return entry === undefined ? host : detect.hosts.get(entry) ?? host
}

/** Characters GitHub renders as nothing: every format character, such as U+200B, and the variation selectors. */
const INVISIBLE = /[\p{Cf}\p{Variation_Selector}]/gu
/** A run of percent escapes, decoded as UTF-8 so an encoded zero-width character shows. */
const PERCENT_RUN = /(?:%[\da-f]{2})+/gi
/** A Markdown backslash escape of ASCII punctuation. */
const BACKSLASH_ESCAPE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g
/** Dots a browser reads as the full stop between host labels. */
const HOST_DOTS = /[。．｡]/g

function decodePercentRun(run: string): string {
  try {
    return decodeURIComponent(run)
  }
  catch {
    // A run that is not valid UTF-8 decodes byte by byte, printable ASCII only.
    return run.replaceAll(/%([2-7][\da-f])/gi, (_escape, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
  }
}

/** Entities, percent escapes, and backslash escapes decoded, a few rounds deep, compatibility forms folded, and invisible characters gone. */
function decodeAll(text: string): string {
  let current = text.replaceAll(INVISIBLE, '')
  for (let round = 0; round < 3; round++) {
    const next = decodeHTML(current).replaceAll(PERCENT_RUN, run => decodePercentRun(run).replaceAll(/[\r\n]/g, ' ')).replaceAll(INVISIBLE, '')
    if (next === current)
      break
    current = next
  }
  return current.replaceAll(BACKSLASH_ESCAPE, '$1').normalize('NFKC').replaceAll(HOST_DOTS, '.').replaceAll(INVISIBLE, '')
}

/** HTML quotes can contain angle brackets and line breaks. Only an unquoted `>` ends a tag. */
const HTML_TAG = /<\/?[a-z][a-z\d-]*(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi
/** A Markdown link or image. Its label renders, its destination does not. */
const MARKDOWN_LINK = /!?\[([^[\]\n]*)\]\([^()\n]*\)/g

/**
 * Removes HTML comments that open and close on one line.
 *
 * One forward scan: when the nearest closer sits past the end of the line,
 * every opener on that line is unclosed, so the scan jumps to the next line.
 */
function withoutInlineComments(text: string): string {
  let output = ''
  let from = 0
  for (;;) {
    const open = text.indexOf('<!--', from)
    const close = open === -1 ? -1 : text.indexOf('-->', open + 4)
    if (close === -1)
      return output + text.slice(from)
    const lineEnd = text.indexOf('\n', open)
    if (lineEnd !== -1 && lineEnd < close) {
      output += text.slice(from, lineEnd + 1)
      from = lineEnd + 1
      continue
    }
    output += text.slice(from, open)
    from = close + 3
  }
}

/** The decoded text without what renders as nothing: comments, tags, link destinations, formatting, dot segments, and doubled slashes. */
function normalise(decoded: string): string {
  return withoutInlineComments(decoded)
    .replaceAll(MARKDOWN_LINK, '$1')
    .replaceAll(HTML_TAG, '')
    .replaceAll(FORMATTING, '')
    .replaceAll(/\/\.(?=\/)/g, '')
    .replaceAll(/(?<!:)\/{2,}/g, '/')
}

/** Resolve filesystem candidates without treating a public URL's path as a local path. */
function normalizedPaths(text: string): string {
  return text
    // Separate joined option values before resolving paths. Require a token
    // boundary so an option-shaped segment inside a public URL stays intact.
    .replaceAll(/(^|[\s"'`(])(-{1,2}[a-z][\w-]*)(?=\/|~[\w-]*\/|\$(?:HOME|\{HOME\})\/)/gi, '$1$2 ')
    // Quotes and code spans can hold directory names with spaces or punctuation.
    .replaceAll(/(["'`])((?:\/|~[\w-]*\/|\$(?:HOME|\{HOME\})\/)[^\r\n]*?)\1/g, (_match, quote: string, path: string) => `${quote}${normalize(path)}${quote}`)
    .replaceAll(/(?<![\w./:~$-])(?:\/|~[\w-]*\/|\$(?:HOME|\{HOME\})\/)[^\s<>"'`]*/g, path => normalize(path))
}

/** Finding identities are reversible transport, so detection must also inspect their decoded text. */
const ENCODED_FINDING = /<!-- review-finding: ([a-f\d]{64}) ([\w-]+) -->/gi

function withoutFindingIdentity(marker: string): string {
  return marker.replaceAll(ENCODED_FINDING, '<!-- review-finding: $1 -->')
}

function decodedFindingIdentities(text: string): string {
  return text.replaceAll(ENCODED_FINDING, (_marker, _fingerprint: string, identity: string) =>
    // An identity may contain newlines. Keep its whole payload on the marker's line.
    Buffer.from(identity, 'base64url').toString('utf8').replaceAll(/[\r\n]/g, ' '))
}

/**
 * Every URL host as a URL parser reads it, from the Service Repair ea3f8596.
 *
 * It resolves percent escapes, case, and Unicode separators in a host the way
 * a browser does, without reading a public URL's path as its authority.
 */
function normalizedAuthorities(text: string): string {
  return text.replaceAll(/((?:[a-z][a-z\d+.-]{0,15}:)?\/\/(?:[^\s/?#<>"`]*@)?)([^\s@:/?#<>"`()[\]]+)/gi, (authority, prefix: string, hostname: string) => {
    // Parse the host alone. Ports and Markdown delimiters cannot invalidate its normalization.
    const url = URL.parse(`http://${hostname}`)
    // An invalid host still passes through the other views.
    return url === null ? authority : `${prefix}${url.hostname}`
  })
}

/**
 * Each line decoded, without the tabs and line breaks a URL parser drops.
 *
 * A browser reads `https://notes.<tab>localhost` in an HTML attribute as the
 * host `notes.localhost`. This view adds matches only; the other views keep
 * the whitespace a path or host may need as a boundary.
 */
function withoutURLWhitespace(text: string): string {
  return text.split('\n').map(line => decodeAll(line).replaceAll(/[\t\r\n]/g, '')).join('\n')
}

function lineBreaks(text: string): number {
  let count = 0
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1))
    count++
  return count
}

/**
 * Applies `transform` without adding or removing a line break, so the result
 * stays line-aligned with `text`. A break the transform makes becomes a space.
 */
function aligned(text: string, transform: (text: string) => string): string {
  const whole = transform(text)
  return lineBreaks(whole) === lineBreaks(text)
    ? whole
    : text.split('\n').map(line => transform(line).replaceAll(/[\r\n]/g, ' ')).join('\n')
}

interface Detectors {
  raw: Detector
  decoded: Detector
  normalised: Detector
  /** Matches an entry glued to anything before it, in text with public URLs removed. */
  joined: Detector
}

function detectorsFor(details: PrivateDetails): Detectors {
  return {
    raw: detector(details, entry => entry, RAW_ENTRY_END),
    decoded: detector(details, entry => entry, ENTRY_END),
    normalised: detector(details, entry => entry.replaceAll(FORMATTING, ''), ENTRY_END),
    joined: detector(details, entry => entry, ENTRY_END, ''),
  }
}

/** A URL with a scheme. File URLs carry filesystem paths; other URL paths stay public. */
const URL_TOKEN = /[a-z][a-z\d+.-]{0,15}:\/\/[^\s<>"'`]*/gi
/** A path start anywhere: after a flag, `=`, `,`, or `:` as well as after a space. */
const JOINED_PATH = /(?:\/|~[\w-]*\/|\$(?:HOME|\{HOME\})\/)[^\s<>"'`,:;=]*/g

/**
 * The text a shell or compiler would read, with public URLs removed.
 *
 * Option parsers glue a path to anything: `-I/x`, `CFLAGS=-I/x`, `-Wp,-I/x`,
 * `PATH=/a:/x`. Requiring a token boundary before an entry missed each new
 * spelling, so this view requires none. File URL paths remain candidates.
 * Public URLs are removed first, so their paths stay public.
 */
function joinedPaths(text: string): string {
  return text
    .replaceAll(URL_TOKEN, (url) => {
      // A file authority must not hide the absolute filesystem path after it.
      const file = /^file:\/\/[^/]*(\/.*)$/i.exec(url)
      return file?.[1] ?? ' '
    })
    .replaceAll(JOINED_PATH, path => normalize(path))
}

/**
 * Every private detail in `text`, with the index of its line. It matches the
 * raw text, the text as GitHub renders it, and that text without Markdown
 * formatting. Every view keeps the line breaks of `text`.
 */
function detailsInAligned(detect: Detectors, text: string): Array<{ line: number, hit: PrivateDetailHit }> {
  const decoded = aligned(text, decodeAll)
  const identities = aligned(decoded, decodedFindingIdentities)
  const parsedURLs = withoutURLWhitespace(text)
  const views: Array<[Detector, string]> = [
    [detect.raw, text],
    [detect.decoded, decoded],
    [detect.decoded, aligned(decoded, normalizedAuthorities)],
    [detect.decoded, parsedURLs],
    [detect.decoded, normalizedAuthorities(parsedURLs)],
    [detect.normalised, aligned(decoded, normalise)],
    [detect.decoded, aligned(decoded, normalizedPaths)],
    [detect.normalised, aligned(decoded, text => normalizedPaths(normalise(text)))],
    [detect.decoded, aligned(identities, decodeAll)],
    [detect.normalised, aligned(identities, text => normalizedPaths(normalise(decodeAll(text))))],
    [detect.joined, aligned(decoded, joinedPaths)],
    [detect.joined, aligned(decoded, text => joinedPaths(normalise(text)))],
    [detect.joined, aligned(identities, text => joinedPaths(decodeAll(text)))],
  ]
  return views.flatMap(([view, viewText]) => {
    const matches = (['Link', 'Path'] as const).flatMap((tag) => {
      const pattern = tag === 'Link' ? view.link : view.path
      return pattern === null ? [] : [...viewText.matchAll(pattern)].map(match => ({ index: match.index ?? 0, hit: { _tag: tag, entry: entryFor(view, tag, match[0]) } }))
    })
    if (matches.length === 0)
      return []
    const starts = [0]
    for (let at = viewText.indexOf('\n'); at !== -1; at = viewText.indexOf('\n', at + 1))
      starts.push(at + 1)
    return matches.map(({ index, hit }) => ({ line: lineAt(starts, index), hit }))
  })
}

/** A character range of one view: `start` inclusive, `end` exclusive. */
interface Region {
  start: number
  end: number
}

/** A run of source lines, both ends inclusive. */
interface LineSpan {
  first: number
  last: number
}

/**
 * The Markdown structure that decides how far inline markup reaches in one view.
 *
 * Code renders its text as written, so markup inside it hides and joins
 * nothing. Inline markup ends with its paragraph, so a comment, tag, link, or
 * code span never reaches past a line that starts another block.
 */
interface Layout {
  starts: number[]
  /** `breaks[i]` counts the lines up to and including line `i` that no paragraph continues into. */
  breaks: number[]
  /** Where each line's content starts, after blockquote markers and up to three spaces. */
  contentStarts: number[]
  /** Fenced code blocks and inline code spans, sorted and disjoint. */
  code: Region[]
  /** Inline code spans that wrap onto another line. */
  wrappedCode: LineSpan[]
}

const CONTAINER = /^(?:[ \t]*>)*/
const CONTENT_START = /^(?:[ \t]*>)*[ \t]{0,3}/
const FENCE = /^[ \t]*(`{3,}(?!`)|~{3,}(?!~))(.*)$/
/** A line that starts a list item, a heading, or a thematic break, which ends any paragraph above it. */
const BLOCK_START = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])(?:\s|$)|#{1,6}(?:\s|$)|([-*_])(?:[ \t]*\1){2,}\s*$)/

function layoutOf(text: string): Layout {
  const lines = text.split('\n')
  const starts: number[] = []
  const contentStarts: number[] = []
  const fenced: boolean[] = []
  const isBreak: boolean[] = []
  const code: Region[] = []
  let offset = 0
  let fence: { char: string, length: number, depth: number, indent: number, start: number } | null = null
  for (const line of lines) {
    starts.push(offset)
    contentStarts.push(offset + (CONTENT_START.exec(line)?.[0].length ?? 0))
    const container = CONTAINER.exec(line)?.[0] ?? ''
    const depth = container.split('>').length - 1
    const rest = line.slice(container.length)
    // Resolve the old container before parsing a new item's opening fence.
    const indentation = rest.match(/^[ \t]*/)?.[0].length ?? 0
    if (fence !== null && (depth < fence.depth || (rest.trim() !== '' && indentation < fence.indent))) {
      code.push({ start: fence.start, end: offset })
      fence = null
    }
    // Consume list markers only outside code. Inside code they are literal.
    let content = rest
    if (fence === null) {
      for (let item = /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/.exec(content); item !== null; item = /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/.exec(content))
        content = content.slice(item[0].length)
    }
    const indent = rest.length - content.length
    const marker = FENCE.exec(content)
    if (fence !== null) {
      fenced.push(true)
      isBreak.push(true)
      if (marker?.[1]?.[0] === fence.char && marker[1].length >= fence.length && marker[2]?.trim() === '') {
        code.push({ start: fence.start, end: offset + line.length })
        fence = null
      }
    }
    else if (marker?.[1] !== undefined && !(marker[1].startsWith('`') && marker[2]?.includes('`'))) {
      fence = { char: marker[1].charAt(0), length: marker[1].length, depth, indent, start: offset }
      fenced.push(true)
      isBreak.push(true)
    }
    else {
      fenced.push(false)
      isBreak.push(rest.trim() === '' || BLOCK_START.test(rest))
    }
    offset += line.length + 1
  }
  if (fence !== null)
    code.push({ start: fence.start, end: text.length })
  const breaks: number[] = []
  isBreak.reduce((count, value, index) => {
    breaks[index] = count + (value ? 1 : 0)
    return breaks[index]
  }, 0)
  // A backtick run opens a code span that the next run of the same length in
  // its paragraph closes. A run with no such partner is literal.
  const runs: Array<{ start: number, end: number, line: number }> = []
  for (const run of text.matchAll(/`+/g)) {
    const line = lineAt(starts, run.index)
    if (!fenced[line])
      runs.push({ start: run.index, end: run.index + run[0].length, line })
  }
  const partner = Array.from<number>({ length: runs.length }).fill(-1)
  const nearest = new Map<number, number>()
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]!
    partner[index] = nearest.get(run.end - run.start) ?? -1
    nearest.set(run.end - run.start, index)
  }
  const wrappedCode: LineSpan[] = []
  for (let index = 0; index < runs.length;) {
    const open = runs[index]!
    const close = runs[partner[index] ?? -1]
    if (close === undefined || breaks[close.line] !== breaks[open.line]) {
      index++
      continue
    }
    code.push({ start: open.start, end: close.end })
    if (close.line > open.line)
      wrappedCode.push({ first: open.line, last: close.line })
    index = (partner[index] ?? index) + 1
  }
  code.sort((left, right) => left.start - right.start)
  return { starts, breaks, contentStarts, code, wrappedCode }
}

/** Whether a paragraph would have to end somewhere between `first` and `last`. */
function crossesBlock(layout: Layout, first: number, last: number): boolean {
  return last > first && (layout.breaks[last] ?? 0) > (layout.breaks[first] ?? 0)
}

/** The code region that holds `offset`, if any. */
function codeAt(layout: Layout, offset: number): Region | undefined {
  let low = 0
  let high = layout.code.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const region = layout.code[middle]!
    if (offset < region.start)
      high = middle - 1
    else if (offset >= region.end)
      low = middle + 1
    else
      return region
  }
  return undefined
}

/**
 * HTML tags and lines changed by HTML removal retain their full source spans.
 *
 * Markup that spans lines renders as text inside code, and inside a line when
 * it would have to cross into another block. A comment opener with no closer
 * also renders as text. Such markup joins no lines, so it never widens a span.
 * Markup on one line is still removed everywhere, so detection keeps seeing a
 * path or host that it splits.
 */
function htmlLines(text: string, layout: Layout): Array<{ text: string, first: number, last: number }> {
  const lines: Array<{ text: string, first: number, last: number }> = []
  let line = 0
  let current = { text: '', first: 0, last: 0 }
  let stripped = false
  const append = (chunk: string) => {
    const parts = chunk.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) {
        if (stripped)
          lines.push(current)
        stripped = false
        line++
        current = { text: '', first: line, last: line }
      }
      current.text += part
      current.last = line
    })
  }
  const markup = new RegExp(`<!--|${HTML_TAG.source}`, 'gi')
  let from = 0
  // The first closer at or after the last search. Reusing it keeps a run of openers linear.
  let closer = -2
  for (let match = markup.exec(text); match !== null; match = markup.exec(text)) {
    const start = match.index
    const comment = match[0] === '<!--'
    if (comment && closer !== -1 && closer < markup.lastIndex)
      closer = text.indexOf('-->', markup.lastIndex)
    if (comment && closer === -1)
      continue
    const end = comment ? closer + 3 : markup.lastIndex
    const first = lineAt(layout.starts, start)
    const last = lineAt(layout.starts, end - 1)
    if (last > first && codeAt(layout, start) !== undefined)
      continue
    // Markup that starts a line may open an HTML block, which can span blocks.
    if (crossesBlock(layout, first, last) && start !== layout.contentStarts[first])
      continue
    markup.lastIndex = end
    append(text.slice(from, start))
    if (!comment && match[0].includes('\n')) {
      // Inspect attributes before stripping the tag. A host on one line makes
      // the destination's filename on every following line private too.
      lines.push({ text: match[0], first: line, last: line + lineBreaks(match[0]) })
      // Markdown removes container prefixes before HTML attribute URLs render.
      // URL parsing then drops tabs and line breaks, including inside hosts.
      const attributeView = match[0].replaceAll(/\r?\n[ \t]*(?:>[ \t]?)+/g, '\n')
      lines.push({ text: decodeAll(attributeView).replaceAll(/[\t\r\n]/g, ''), first: line, last: line + lineBreaks(match[0]) })
    }
    line += lineBreaks(text.slice(start, end))
    current.last = line
    stripped = true
    from = end
  }
  append(text.slice(from))
  if (stripped)
    lines.push(current)
  return lines
}

/** A line break inside a paragraph: the next line holds more than blockquote markers. */
const SOFT_BREAK = String.raw`\r?\n(?![ \t>]*(?:\r?\n|$))`
/** Optional spaces, then at most one line break and the next line's blockquote markers. */
const LINK_GAP = String.raw`[ \t]*(?:${SOFT_BREAK}[ \t>]*)?`
const LINK_TITLE = String.raw`"(?:\\[^\r\n]|[^\\"\r\n]|${SOFT_BREAK})*"|'(?:\\[^\r\n]|[^\\'\r\n]|${SOFT_BREAK})*'|\((?:\\[^\r\n]|[^\\()\r\n]|${SOFT_BREAK})*\)`
const INLINE_GAP = new RegExp(LINK_GAP, 'y')
const INLINE_TITLE = new RegExp(LINK_TITLE, 'y')

/** Read a balanced destination and its optional title, for either link form. */
function linkTailEnd(text: string, start: number, parentheses: ReadonlyMap<number, number>): number | undefined {
  const gap = (at: number) => {
    INLINE_GAP.lastIndex = at
    return at + (INLINE_GAP.exec(text)?.[0].length ?? 0)
  }
  let at = gap(start)
  if (text[at] === '<') {
    at++
    while (at < text.length && !/[<>\r\n]/.test(text[at]!)) {
      at += text[at] === '\\' ? 2 : 1
    }
    if (text[at] !== '>')
      return undefined
    at++
  }
  else {
    while (at < text.length) {
      const char = text[at]!
      if (char === '\\') {
        at += 2
        continue
      }
      if (/[\s<>)]/.test(char))
        break
      if (char === '(') {
        const close = parentheses.get(at)
        if (close === undefined)
          return undefined
        at = close
      }
      at++
    }
  }
  const afterGap = gap(at)
  if (afterGap > at) {
    INLINE_TITLE.lastIndex = afterGap
    const title = INLINE_TITLE.exec(text)
    at = title === null ? afterGap : gap(afterGap + title[0].length)
  }
  return at
}

/** Keep label nesting and destination nesting independent, including linked images. */
function markdownLinks(text: string, layout: Layout): Region[] {
  // Resolve nested destinations once. Repeated unmatched openers stay linear.
  const parentheses = new Map<number, number>()
  const open: number[] = []
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!
    if (char === '\\') {
      at++
      continue
    }
    if (/[\s<>]/.test(char))
      open.length = 0
    if (char === '(')
      open.push(at)
    if (char === ')') {
      const start = open.pop()
      if (start !== undefined)
        parentheses.set(start, at)
    }
  }
  const labels: number[] = []
  const links: Region[] = []
  for (let at = 0; at < text.length; at++) {
    const code = codeAt(layout, at)
    if (code !== undefined) {
      at = code.end - 1
      continue
    }
    if (text[at] === '\\') {
      at++
      continue
    }
    if (text[at] === '[')
      labels.push(at)
    if (text[at] !== ']')
      continue
    const start = labels.pop()
    if (start === undefined || text[at + 1] !== '(')
      continue
    const end = linkTailEnd(text, at + 2, parentheses)
    if (end !== undefined && text[end] === ')') {
      links.push({ start, end: end + 1 })
      at = end
    }
  }
  for (const match of text.matchAll(LINK_DEFINITION)) {
    const end = linkTailEnd(text, match.index + match[0].length, parentheses)
    if (end !== undefined)
      links.push({ start: match.index, end })
  }
  return links
}
/** A link reference definition. Its destination and title may each start on the next line. */
const LINK_DEFINITION = /^[ \t]*(?:>[ \t]*)*\[(?:\\[^\r\n]|[^\\[\]\r\n])+\]:/gm

/** Links and code spans that wrap onto another line, outside code and within one paragraph. */
function wrappedConstructs(text: string, layout: Layout): LineSpan[] {
  const regions = markdownLinks(text, layout)
  const links = regions.flatMap(({ start, end }) => {
    const first = lineAt(layout.starts, start)
    const last = lineAt(layout.starts, end - 1)
    return last === first || crossesBlock(layout, first, last) || codeAt(layout, start) !== undefined ? [] : [{ first, last }]
  })
  return [...links, ...layout.wrappedCode]
}

/**
 * The wrapped links and code spans that share a line with a span.
 *
 * A hit on any line of one removes all of its lines. Otherwise a title or a
 * filename on its next line outlives the host or path that made it private.
 */
function constructsTouching(spans: readonly LineSpan[], constructs: readonly LineSpan[], lineCount: number): LineSpan[] {
  if (spans.length === 0 || constructs.length === 0)
    return []
  const depth = Array.from<number>({ length: lineCount + 1 }).fill(0)
  for (const { first, last } of spans) {
    depth[first] = (depth[first] ?? 0) + 1
    depth[last + 1] = (depth[last + 1] ?? 0) - 1
  }
  // `marked[i]` counts the lines before `i` that a span covers.
  const marked = [0]
  let open = 0
  for (let line = 0; line < lineCount; line++) {
    open += depth[line] ?? 0
    marked.push((marked[line] ?? 0) + (open > 0 ? 1 : 0))
  }
  return constructs.filter(({ first, last }) => (marked[last + 1] ?? 0) > (marked[first] ?? 0))
}

/** Parse HTML before decoding attribute entities, including each encoded transport layer. */
function detailsIn(detect: Detectors, text: string): { spans: Array<{ first: number, last: number }>, hits: PrivateDetailHit[] } {
  const spans: Array<{ first: number, last: number }> = []
  const hits = new Map<string, PrivateDetailHit>()
  const remember = (hit: PrivateDetailHit) => hits.set(`${hit._tag}:${hit.entry}`, hit)
  for (const { line, hit } of detailsInAligned(detect, text)) {
    spans.push({ first: line, last: line })
    remember(hit)
  }
  const decoded = aligned(text, decodeAll)
  const sources = new Set([text, aligned(text, decodedFindingIdentities), aligned(decoded, decodedFindingIdentities)])
  const views = new Set([decoded])
  // Native reviews encode their payload. Preserve HTML boundaries at every layer.
  // Decoding all layers first can turn an attribute entity into a closing quote.
  for (const source of sources) {
    views.add(source)
    let layer = source
    for (let round = 0; round < 3; round++) {
      const next = aligned(layer, decodeHTML)
      if (next === layer)
        break
      views.add(next)
      layer = next
    }
  }
  const constructs: LineSpan[] = []
  for (const view of views) {
    const layout = layoutOf(view)
    for (const rendered of htmlLines(view, layout)) {
      const found = detailsInAligned(detect, rendered.text)
      if (found.length > 0)
        spans.push({ first: rendered.first, last: rendered.last })
      for (const { hit } of found)
        remember(hit)
    }
    constructs.push(...wrappedConstructs(view, layout))
  }
  spans.push(...constructsTouching(spans, constructs, lineBreaks(text) + 1))
  // Merge before expanding. Repeated matches and views must never multiply source lines.
  spans.sort((left, right) => left.first - right.first)
  const merged: typeof spans = []
  for (const span of spans) {
    const previous = merged.at(-1)
    if (previous !== undefined && span.first <= previous.last + 1)
      previous.last = Math.max(previous.last, span.last)
    else
      merged.push(span)
  }
  return { spans: merged, hits: [...hits.values()] }
}

/** The index of the line that holds `offset`, given each line's first offset in order. */
function lineAt(starts: readonly number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if ((starts[middle] ?? 0) <= offset)
      low = middle
    else
      high = middle - 1
  }
  return low
}

/** The line that stands in for `line`, and the markers it keeps. */
function removedLine(detect: Detectors, line: string): string {
  const structure = LINE_STRUCTURE.exec(line)?.[0] ?? ''
  const markers = htmlComments(line).flatMap((marker) => {
    if (detailsIn(detect, marker).hits.length === 0)
      return [marker]
    const fingerprintOnly = withoutFindingIdentity(marker)
    return fingerprintOnly !== marker && detailsIn(detect, fingerprintOnly).hits.length === 0 ? [fingerprintOnly] : []
  })
  return [`${structure}${REMOVED_LINE}`, ...markers].join(' ')
}

/**
 * Replaces every line that names a private detail with `REMOVED_LINE`.
 *
 * It matches the raw text and the text as GitHub renders it, so no entity,
 * escape, invisible character, or Markdown formatting hides an entry. A false
 * match costs one line and an Incident. A partial leak is never possible.
 */
export function redactPrivateDetails(text: string, details: PrivateDetails): Redaction {
  const { text: redacted, hits } = guarded(detectorsFor(details), text)
  return { text: redacted, hits }
}

/** A redaction, with the source lines it removed and whether it withheld the body. */
interface Guarded extends Redaction {
  removed: ReadonlySet<number>
  withheld: boolean
}

function guarded(detect: Detectors, text: string): Guarded {
  const found = detailsIn(detect, text)
  const removed = new Set<number>()
  for (const { first, last } of found.spans) {
    for (let line = first; line <= last; line++)
      removed.add(line)
  }
  const hits = found.hits
  const lines = hits.length === 0
    ? text
    : text.split('\n').map((line, index) => removed.has(index) ? `${removedLine(detect, line)}${line.endsWith('\r') ? '\r' : ''}` : line).join('\n')
  const residue = joinedHits(detect, lines)
  if (residue.length > 0)
    return { text: withheldBody(detect, lines), hits: [...new Map([...hits, ...residue].map(hit => [`${hit._tag}:${hit.entry}`, hit])).values()], removed, withheld: true }
  return { text: lines, hits, removed, withheld: false }
}

/** The text that replaces a whole body when a private detail spans its lines. */
const WITHHELD_BODY = '_This text was withheld: it named a private path or host across lines._'

/** A line that holds only HTML comment markers, which the parsers read. */
function isMarkerLine(line: string): boolean {
  let from = 0
  let comments = 0
  while (from < line.length) {
    if (/\s/.test(line.charAt(from))) {
      from++
      continue
    }
    if (!line.startsWith('<!--', from))
      return false
    const close = line.indexOf('-->', from + 4)
    if (close === -1)
      return false
    from = close + 3
    comments++
  }
  return comments > 0
}

/**
 * Private details that only appear once lines join.
 *
 * Per-line views cannot see a host or path split by a source newline, which
 * HTML attributes and URL parsers ignore. Every such spelling found one review
 * at a time, so this check runs after line removal on the whole body: joined
 * by a space, and joined directly.
 */
function joinedHits(detect: Detectors, text: string): PrivateDetailHit[] {
  if (!text.includes('\n'))
    return []
  return [text.replaceAll(/\r?\n/g, ' '), text.replaceAll(/\r?\n/g, '')]
    .flatMap(joined => detailsIn(detect, joined).hits)
}

/** Keeps the marker lines that name nothing private, then one withheld line. */
function withheldBody(detect: Detectors, text: string): string {
  const markers = text.split('\n').filter(line => isMarkerLine(line) && detailsIn(detect, line).hits.length === 0)
  return [...markers, WITHHELD_BODY].join('\n')
}

/** Whether `published` is the withheld form of `source`: its marker lines in order, then the withheld line. */
function isWithheldFormOf(published: string, source: string): boolean {
  const lines = published.split('\n')
  if (lines.at(-1) !== WITHHELD_BODY)
    return false
  const markers = source.split('\n').filter(isMarkerLine)
  let from = 0
  return lines.slice(0, -1).every((line) => {
    const at = markers.indexOf(line, from)
    from = at + 1
    return at !== -1
  })
}

/** Whether `line` is what the guard writes in place of `source`, under any deny list. */
function isRemovedFormOf(line: string, source: string): boolean {
  const structure = LINE_STRUCTURE.exec(source)?.[0] ?? ''
  if (!line.startsWith(`${structure}${REMOVED_LINE}`))
    return false
  const rest = line.slice(structure.length + REMOVED_LINE.length)
  const markers = htmlComments(rest)
  const sourceMarkers = htmlComments(source)
  return markers.reduce((remainder, marker) => remainder.replace(marker, ''), rest).trim() === ''
    && markers.every(marker => sourceMarkers.some(source => source === marker || withoutFindingIdentity(source) === marker))
}

/**
 * Whether GitHub's `published` body is `source` after the guard removed lines.
 *
 * It holds whatever deny list the writer used, so a comment written before a
 * configuration change still matches the Journal text that produced it. Every
 * other line must be equal, and the line count must not change.
 */
export function isPublishedForm(published: string, source: string): boolean {
  if (published === source || isWithheldFormOf(published, source))
    return true
  const publishedLines = published.split('\n')
  const sourceLines = source.split('\n')
  return publishedLines.length === sourceLines.length
    && publishedLines.every((line, index) => line === sourceLines[index] || isRemovedFormOf(line, sourceLines[index] ?? ''))
}

/**
 * Whether GitHub's `published` body is `source`, or `source` as this deny list redacts it.
 *
 * A compare and swap reads it. `isPublishedForm` lets a removed line stand in
 * for any source line of the same shape, so a stale write could replace a
 * newer body that differs only on a removed line. Here a removed line stands
 * in only for a line this deny list removes, and a withheld body only for a
 * source it withholds. The Journal keeps every entry a configuration ever
 * named, so a body written under an earlier deny list still matches. A body
 * that an earlier version of the guard removed more lines from reads as
 * changed, so the caller ends that publication instead of writing.
 */
export function isRedactedFormOf(published: string, source: string, details: PrivateDetails): boolean {
  if (published === source)
    return true
  const redaction = guarded(detectorsFor(details), source)
  if (redaction.withheld && isWithheldFormOf(published, source))
    return true
  const publishedLines = published.split('\n')
  const sourceLines = source.split('\n')
  return publishedLines.length === sourceLines.length
    && publishedLines.every((line, index) => line === sourceLines[index]
      || (redaction.removed.has(index) && isRemovedFormOf(line, sourceLines[index] ?? '')))
}

/**
 * Keeps removed every line GitHub already shows removed, when an edit repeats it.
 *
 * The deny list can change between two writes of one comment. A line the old
 * list removed must stay removed, even when the current list no longer knows
 * why, so `next` reuses the exact line GitHub holds for each such source line.
 */
export function preservePublishedRedactions(published: string, source: string, next: string): string {
  const publishedLines = published.split('\n')
  const sourceLines = source.split('\n')
  if (publishedLines.length !== sourceLines.length)
    return next
  const removed = new Map<string, string>()
  sourceLines.forEach((line, index) => {
    const shown = publishedLines[index] ?? line
    if (shown !== line && isRemovedFormOf(shown, line))
      removed.set(line, shown)
  })
  return removed.size === 0 ? next : next.split('\n').map(line => removed.get(line) ?? line).join('\n')
}

/**
 * Keeps removed each line GitHub shows removed, by position.
 *
 * For a comment the controller rebuilds whole from the same finding on every
 * pass, where the Journal keeps no earlier source text. A line in `next` stays
 * removed when GitHub shows a removed line of the same shape at its position,
 * so a deny list change cannot publish it again.
 */
export function keepRemovedLines(published: string, next: string): string {
  if (!published.includes(REMOVED_LINE))
    return next
  const publishedLines = published.split('\n')
  return next.split('\n').map((line, index) => {
    const shown = publishedLines[index]
    return shown !== undefined && shown !== line && isRemovedFormOf(shown, line) ? shown : line
  }).join('\n')
}

/** What a published body is, in GitHub's words and the GLOSSARY's. */
export type PublicTextWriter
  = | 'automated review'
    | 'automated triage'
    | 'review comment'
    | 'review'
    | 'comment'
    | 'issue'
    | 'pull request description'
    | 'release comment'
    | 'GitHub release'

export interface PublicTextTarget {
  repository: string
  /** Null when GitHub has not numbered the item yet, or the writer does not know it. */
  itemNumber: number | null
  writer: PublicTextWriter
}

export interface PrivateDetailLeak extends PublicTextTarget {
  hits: readonly PrivateDetailHit[]
}

/**
 * What every GitHub writer needs to keep private details out of a body.
 *
 * Each publisher takes it as a required option, so no writer exists without it.
 */
export interface PublicTextGuard {
  details: PrivateDetails
  report: (leak: PrivateDetailLeak) => void
}

/**
 * One body on its way to GitHub.
 *
 * `text` is the redacted body, for every comparison before the write. `send`
 * writes it and reports the redaction once GitHub accepts the write, so a
 * report always means a published body: a no-op, a refused authorization, or
 * a write GitHub rejects reports nothing.
 */
export interface PublicBody {
  text: string
  /** `itemNumber` reads the number GitHub gave a new item from the write's result. */
  send: <T>(write: (body: string) => Promise<T>, itemNumber?: (written: T) => number) => Promise<T>
}

/**
 * Several texts on their way to GitHub in one write, such as a title and a body.
 *
 * GitHub renders each field alone, so the guard redacts each alone. A body it
 * withholds never takes the title's place. `send` reports the hits of every
 * field once, after GitHub accepts the write.
 */
export interface PublicFields<Field extends string> {
  text: Record<Field, string>
  send: <T>(write: (fields: Record<Field, string>) => Promise<T>, itemNumber?: (written: T) => number) => Promise<T>
}

export function publicFields<Field extends string>(guard: PublicTextGuard, target: PublicTextTarget, source: Record<Field, string>): PublicFields<Field> {
  const redactions = (Object.entries(source) as Array<[Field, string]>).map(([field, text]) => [field, redactPrivateDetails(text, guard.details)] as const)
  const text = Object.fromEntries(redactions.map(([field, redaction]) => [field, redaction.text])) as Record<Field, string>
  const hits = [...new Map(redactions.flatMap(([, redaction]) => redaction.hits).map(hit => [`${hit._tag}:${hit.entry}`, hit])).values()]
  let reported = false
  return {
    text,
    send: async (write, itemNumber) => {
      const written = await write(text)
      if (!reported && hits.length > 0) {
        reported = true
        guard.report({ ...target, itemNumber: target.itemNumber ?? itemNumber?.(written) ?? null, hits })
      }
      return written
    },
  }
}

export function publicBody(guard: PublicTextGuard, target: PublicTextTarget, source: string): PublicBody {
  const fields = publicFields(guard, target, { body: source })
  return {
    text: fields.text.body,
    send: (write, itemNumber) => fields.send(sent => write(sent.body), itemNumber),
  }
}

export const PRIVATE_DETAIL_OPERATION = 'public_text'

/**
 * One stable sentence per item and writer, so a sticky comment that keeps the
 * leak raises the occurrence count on one Incident instead of adding rows.
 */
export function privateDetailIncidentMessage(leak: PrivateDetailLeak): string {
  const entries = [...new Set(leak.hits.map(hit => hit.entry))].sort().join(', ')
  const item = leak.itemNumber === null ? `the ${leak.writer} in ${leak.repository}` : `the ${leak.writer} on ${leak.repository}#${leak.itemNumber}`
  return `The controller removed private details (${entries}) from ${item}. Find the template or agent output that wrote them.`
}

/**
 * Records each redaction as an Incident on its repository. Only a person resolves it.
 *
 * The Journal keeps every root and host any configuration ever named, so an
 * entry that leaves the configuration stays private. The report runs after
 * GitHub accepted the write, so a Journal failure is logged and never turns
 * that accepted write into an error.
 */
export function createPublicTextGuard(options: {
  details: PrivateDetails
  store: Pick<JournalStore, 'recordIncident' | 'retainPrivateDetails'>
  now: () => Date
  log: (message: string) => void
}): PublicTextGuard {
  return {
    details: options.store.retainPrivateDetails(options.details),
    report: (leak) => {
      const message = privateDetailIncidentMessage(leak)
      try {
        options.store.recordIncident({
          scope: { _tag: 'Repository', repository: leak.repository },
          kind: 'private_detail',
          severity: 'warning',
          operation: PRIVATE_DETAIL_OPERATION,
          message,
          recovery: { _tag: 'ActionRequired' },
          at: options.now().toISOString(),
        })
      }
      catch (error) {
        options.log(`${message} The Incident was not recorded: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}
