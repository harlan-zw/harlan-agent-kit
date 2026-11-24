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

/**
 * The Markdown structure that decides how far HTML markup reaches in one view.
 *
 * Code renders its text as written, so multi-line markup inside it hides and
 * joins nothing. Markup inside a line ends with its paragraph, so it never
 * reaches past a line that starts another block.
 */
interface Layout {
  starts: number[]
  /**
   * `breaks[i]` counts the lines up to and including line `i` that no paragraph continues into.
   *
   * It counts only the lines that end a paragraph whatever their context. A
   * missed break groups too many lines, which removes public text. A false
   * break leaves the rest of a private tag behind.
   */
  breaks: number[]
  /** Whether line `i` opens a blockquote deeper than the paragraph above it, so it continues nothing. */
  deeper: boolean[]
  /** Where each line's content starts, after blockquote markers and up to three spaces. */
  contentStarts: number[]
  /** Fenced code blocks and inline code spans, sorted and disjoint. */
  code: Region[]
}

const CONTAINER = /^(?:[ \t]*>)*/
const CONTENT_START = /^(?:[ \t]*>)*[ \t]{0,3}/
const FENCE = /^[ \t]*(`{3,}(?!`)|~{3,}(?!~))(.*)$/
/**
 * Blockquote markers as Markdown reads them, with at most three spaces before
 * each. After four spaces or a tab, `>` is paragraph text.
 */
const QUOTE_MARKERS = /^(?: {0,3}>[ \t]?)*/
/** Blockquote markers at any indentation, the widest reading. */
const ANY_QUOTE_MARKERS = /^(?:[ \t]*>[ \t]?)*/
/** A list marker at most three spaces in, before whitespace or the line end. */
const LIST_MARKER = /^( {0,3})(?:[-*+]|(\d{1,9})[.)])(?=[ \t]|$)[ \t]*/
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
/**
 * Any line that might start a block, at any indentation: a list item, a
 * heading, a thematic break, a setext underline, or HTML. Code spans never
 * pair across one, because a code span that is not there hides real markup.
 */
const POSSIBLE_BLOCK_START = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])(?:\s|$)|#{1,6}(?:\s|$)|([-*_])(?:[ \t]*\1){2,}\s*$|(?:=+|-+)\s*$|<[a-z/!?])/i
/** A block that is always one line long, so the next line starts another block. */
const POSSIBLE_ONE_LINE_BLOCK = /^[ \t]*(?:#{1,6}(?:\s|$)|([-*_])(?:[ \t]*\1){2,}\s*$|(?:=+|-+)\s*$)/

/** Block HTML continues through Markdown markers until a blank line. */
const HTML_BLOCK = /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[\s/>])/i
const HTML_BLOCK_TAG = new RegExp(`^ {0,3}${HTML_TAG.source}[ \\t]*$`, 'i')

type HtmlBlockEnd = { _tag: 'Blank' } | { _tag: 'Closing', pattern: RegExp }

/**
 * Raw HTML owns its lines, including lines that resemble Markdown fences or quotes.
 *
 * A lone complete tag opens a block only where no paragraph continues. Inside
 * a paragraph it is inline HTML, and a fence on the next line is still a fence.
 */
function htmlBlockEnd(rest: string, inParagraph: boolean): HtmlBlockEnd | null {
  const literal = /^ {0,3}<(script|pre|style|textarea)(?=[\s>])/i.exec(rest)
  if (literal !== null)
    return { _tag: 'Closing', pattern: new RegExp(`</${literal[1]}[ \\t]*>`, 'i') }
  for (const [start, end] of [['<!--', /-->/], ['<?', /\?>/], ['<![CDATA[', /\]\]>/]] as const) {
    if (rest.trimStart().startsWith(start))
      return { _tag: 'Closing', pattern: end }
  }
  if (/^ {0,3}<![A-Z]/.test(rest))
    return { _tag: 'Closing', pattern: />/ }
  return HTML_BLOCK.test(rest) || (!inParagraph && HTML_BLOCK_TAG.test(rest)) ? { _tag: 'Blank' } : null
}

/** An open paragraph: its blockquote depth, and the content column of the list item it starts in. */
interface OpenParagraph {
  depth: number
  /**
   * The most blockquote markers any of its lines holds, at any indentation.
   * Inside a list item, a marker four spaces in can still open a blockquote,
   * so only a line past this count opens a deeper one for certain.
   */
  widest: number
  item: number | null
}

/**
 * Whether `rest`, a line after its blockquote markers, ends `paragraph`.
 *
 * It follows CommonMark. A heading or thematic break always ends a paragraph.
 * A bullet item, or an ordered item that starts at 1, ends it when the item
 * holds text. Any list marker ends it when the line is lazy, or sits left of
 * the content column of the list item the paragraph starts in, because then a
 * list item closes and the marker opens the next one.
 */
function endsParagraph(rest: string, paragraph: OpenParagraph, lazy: boolean): boolean {
  if (ATX_HEADING.test(rest) || THEMATIC_BREAK.test(rest))
    return true
  const marker = LIST_MARKER.exec(rest)
  if (marker === null)
    return false
  const holdsText = rest.length > marker[0].length && rest.slice(marker[0].length).trim() !== ''
  if (holdsText && (marker[2] === undefined || Number(marker[2]) === 1))
    return true
  return lazy || (paragraph.item !== null && (marker[1]?.length ?? 0) < paragraph.item)
}

/**
 * How many list markers on one line `opensParagraph` reads. Each costs a scan
 * of the line, so the cap keeps a line of markers linear. Past it, the item
 * column reads too small, which only ends fewer paragraphs.
 */
const NESTED_LIST_MARKERS = 8

/** `paragraph` after a line that continues it and holds `depth` blockquote markers at any indentation. */
function continued(paragraph: OpenParagraph | null, depth: number): OpenParagraph | null {
  return paragraph === null ? null : { ...paragraph, widest: Math.max(paragraph.widest, depth) }
}

/** The paragraph that `rest` opens, or null for a heading, a thematic break, or a list item with no text yet. */
function opensParagraph(rest: string, depth: number, widest: number): OpenParagraph | null {
  let item: number | null = null
  let content = rest
  for (let nested = 0; nested < NESTED_LIST_MARKERS; nested++) {
    if (ATX_HEADING.test(content) || THEMATIC_BREAK.test(content))
      return null
    const marker = LIST_MARKER.exec(content)
    if (marker === null)
      return { depth, widest, item }
    if (content.slice(marker[0].length).trim() === '')
      return null
    item = (item ?? 0) + marker[0].length
    content = content.slice(marker[0].length)
  }
  return { depth, widest, item }
}

function layoutOf(text: string, removed: ReadonlySet<number> = new Set()): Layout {
  const lines = text.split('\n')
  const starts: number[] = []
  const contentStarts: number[] = []
  const fenced: boolean[] = []
  const definite: boolean[] = []
  const possible: boolean[] = []
  const deeper: boolean[] = []
  const code: Region[] = []
  let offset = 0
  let fence: { char: string, length: number, depth: number, start: number } | null = null
  let paragraph: OpenParagraph | null = null
  let previousQuotes: string | null = null
  let previousOneLine = false
  let html: HtmlBlockEnd | null = null
  for (const [index, original] of lines.entries()) {
    // Read the outgoing structure without discarding the original attribute evidence.
    const line = removed.has(index) ? `${LINE_STRUCTURE.exec(original)?.[0] ?? ''}${REMOVED_LINE}` : original
    starts.push(offset)
    contentStarts.push(offset + (CONTENT_START.exec(line)?.[0].length ?? 0))
    const container = CONTAINER.exec(line)?.[0] ?? ''
    const fenceDepth = container.split('>').length - 1
    const marker = FENCE.exec(line.slice(container.length))
    // A fence inside a blockquote ends with the blockquote.
    if (fence !== null && fenceDepth < fence.depth) {
      code.push({ start: fence.start, end: offset })
      fence = null
    }
    const anyQuotes = ANY_QUOTE_MARKERS.exec(line)?.[0] ?? ''
    const anyRest = line.slice(anyQuotes.length)
    // A lazy line closes the containers of the paragraph, so a lone tag there opens a block.
    const lineDepth = (QUOTE_MARKERS.exec(line)?.[0] ?? '').split('>').length - 1
    if (fence === null)
      html ??= htmlBlockEnd(anyRest, paragraph !== null && lineDepth >= paragraph.depth)
    if (html !== null && fence === null) {
      const blank = line.trim() === ''
      fenced.push(!blank)
      definite.push(blank)
      possible.push(true)
      deeper.push(false)
      paragraph = null
      if ((html._tag === 'Blank' && blank) || (html._tag === 'Closing' && html.pattern.test(line)))
        html = null
    }
    else if (fence !== null || (marker?.[1] !== undefined && !(marker[1].startsWith('`') && marker[2]?.includes('`')))) {
      if (fence === null && marker?.[1] !== undefined) {
        fence = { char: marker[1].charAt(0), length: marker[1].length, depth: fenceDepth, start: offset }
      }
      else if (fence !== null && marker?.[1]?.[0] === fence.char && marker[1].length >= fence.length && marker[2]?.trim() === '') {
        code.push({ start: fence.start, end: offset + line.length })
        fence = null
      }
      fenced.push(true)
      definite.push(true)
      possible.push(true)
      deeper.push(false)
      paragraph = null
    }
    else {
      const quotes = QUOTE_MARKERS.exec(line)?.[0] ?? ''
      const depth = quotes.split('>').length - 1
      const anyDepth = anyQuotes.split('>').length - 1
      const rest = line.slice(quotes.length)
      const blank = rest.trim() === ''
      const goesDeeper: boolean = paragraph !== null && depth > paragraph.widest
      const ends: boolean = blank || paragraph === null || goesDeeper || endsParagraph(rest, paragraph, depth < paragraph.depth)
      fenced.push(false)
      definite.push(ends)
      deeper.push(goesDeeper)
      possible.push(ends || anyQuotes !== previousQuotes || anyRest.trim() === '' || POSSIBLE_BLOCK_START.test(anyRest) || previousOneLine)
      paragraph = blank ? null : ends ? opensParagraph(rest, depth, anyDepth) : continued(paragraph, anyDepth)
    }
    previousQuotes = anyQuotes
    previousOneLine = POSSIBLE_ONE_LINE_BLOCK.test(anyRest)
    offset += original.length + 1
  }
  if (fence !== null)
    code.push({ start: fence.start, end: text.length })
  const breaks = runningCount(definite)
  // A backtick run opens a code span that the next run of the same length in
  // its paragraph closes. A run with no such partner is literal. Pairing uses
  // every line that might end a paragraph, so a guess never makes code.
  const codeBreaks = runningCount(possible)
  const runs: Array<{ start: number, end: number, line: number }> = []
  for (const run of text.matchAll(/`+/g)) {
    const line = lineAt(starts, run.index)
    if (!fenced[line] && !removed.has(line))
      runs.push({ start: run.index, end: run.index + run[0].length, line })
  }
  const partner = Array.from<number>({ length: runs.length }).fill(-1)
  const nearest = new Map<number, number>()
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]!
    partner[index] = nearest.get(run.end - run.start) ?? -1
    nearest.set(run.end - run.start, index)
  }
  for (let index = 0; index < runs.length;) {
    const open = runs[index]!
    const close = runs[partner[index] ?? -1]
    if (close === undefined || codeBreaks[close.line] !== codeBreaks[open.line]) {
      index++
      continue
    }
    code.push({ start: open.start, end: close.end })
    index = (partner[index] ?? index) + 1
  }
  code.sort((left, right) => left.start - right.start)
  return { starts, breaks, deeper, contentStarts, code }
}

/** For each index, how many values up to and including it are true. */
function runningCount(values: readonly boolean[]): number[] {
  const counts: number[] = []
  let count = 0
  for (const value of values) {
    if (value)
      count++
    counts.push(count)
  }
  return counts
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
      // From the Service Repair 45bd9228. Markdown removes each continuation
      // line's container markers and indentation before an attribute URL
      // renders, and the URL parser then drops tabs and line breaks.
      const attributes = match[0].split('\n').map((part, index) => index === 0 ? part : withoutContainers(part)).join('\n')
      lines.push({ text: decodeAll(attributes).replaceAll(/[\t\r\n]/g, ''), first: line, last: line + lineBreaks(match[0]) })
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

/** Parse HTML before decoding attribute entities, including each encoded transport layer. */
function detailsIn(detect: Detectors, text: string, removed: ReadonlySet<number> = new Set()): { spans: Array<{ first: number, last: number }>, hits: PrivateDetailHit[] } {
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
  for (const view of views) {
    for (const rendered of htmlLines(view, layoutOf(view, removed))) {
      const found = detailsInAligned(detect, rendered.text)
      if (found.length > 0)
        spans.push({ first: rendered.first, last: rendered.last })
      for (const { hit } of found)
        remember(hit)
    }
  }
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

function guarded(detect: Detectors, text: string, initial: ReadonlySet<number> = new Set()): Guarded {
  const removed = new Set(initial)
  const hits: PrivateDetailHit[] = []
  // Each pass retains source evidence and reads the structure after earlier removals.
  // Bound repeated parsing. If structure keeps changing, withhold the body.
  let settled = false
  for (let pass = 0; pass < 4; pass++) {
    const found = detailsIn(detect, text, removed)
    const before = removed.size
    for (const { first, last } of found.spans) {
      for (let line = first; line <= last; line++)
        removed.add(line)
    }
    if (removed.size === before) {
      settled = true
      break
    }
    hits.push(...found.hits)
  }
  const lines = removed.size === 0
    ? text
    : text.split('\n').map((line, index) => removed.has(index) ? `${removedLine(detect, line)}${line.endsWith('\r') ? '\r' : ''}` : line).join('\n')
  const residue = joinedHits(detect, lines)
  if (!settled || residue.length > 0)
    return { text: withheldBody(detect, lines), hits: [...new Map([...hits, ...residue].map(hit => [`${hit._tag}:${hit.entry}`, hit])).values()], removed, withheld: true }
  return { text: lines, hits: [...new Map(hits.map(hit => [`${hit._tag}:${hit.entry}`, hit])).values()], removed, withheld: false }
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
 * by a space, and joined directly. Markdown removes each line's blockquote and
 * list markers before a quoted or listed HTML attribute reaches a URL parser,
 * so the lines also join without those markers.
 *
 * Markdown never removes the list marker of a line that continues the line
 * above it: that marker starts a new list item, or stays as text. A deeper
 * blockquote marker starts a new blockquote. So the join without markers
 * keeps a space before such a line, and two list items never form a host.
 * The joins that keep the markers still read those lines directly.
 */
function joinedHits(detect: Detectors, text: string): PrivateDetailHit[] {
  if (!text.includes('\n'))
    return []
  const lines = text.split('\n').map(line => line.replace(/\r$/, ''))
  const { deeper } = layoutOf(lines.join('\n'))
  const contents = lines.map(containerContent)
  const unmarked = contents.map(({ content, listItem }, index) => index > 0 && (listItem || deeper[index]) ? ` ${content}` : content).join('')
  return [...new Set([lines.join(' '), lines.join(''), contents.map(({ content }) => content).join(' '), unmarked])]
    .flatMap(joined => detailsIn(detect, joined).hits)
}

/** A blockquote marker, or a list marker before whitespace, after any indentation. */
const CONTAINER_MARKER = /[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$))/y

/** A line without the blockquote markers, list markers, and indentation that Markdown removes. */
function withoutContainers(line: string): string {
  return containerContent(line).content
}

/** A line's content after its blockquote and list markers, and whether one of those was a list marker. */
function containerContent(line: string): { content: string, listItem: boolean } {
  let at = 0
  let listItem = false
  for (;;) {
    CONTAINER_MARKER.lastIndex = at
    const marker = CONTAINER_MARKER.exec(line)
    if (marker === null)
      return { content: line.slice(at).replace(/^[ \t]+/, ''), listItem }
    listItem ||= !marker[0].endsWith('>')
    at = CONTAINER_MARKER.lastIndex
  }
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
 * For one line of an edit's source and its index, the removed line GitHub
 * already shows in its place, if any.
 *
 * The deny list can change between two writes of one comment. A line the old
 * list removed must stay removed, even when the current list no longer knows
 * why. `publicBody` asks only after it redacts the intact source, so a kept
 * removal never hides a host from the rest of its tag.
 */
export type KeptRemovals = (line: string, index: number) => string | undefined

/** Keeps removed each source line GitHub shows removed, wherever an edit repeats that line. */
export function removalsBySource(published: string, source: string): KeptRemovals {
  const publishedLines = published.split('\n')
  const sourceLines = source.split('\n')
  const removed = new Map<string, string>()
  if (publishedLines.length === sourceLines.length) {
    sourceLines.forEach((line, index) => {
      const shown = publishedLines[index] ?? line
      if (shown !== line && isRemovedFormOf(shown, line))
        removed.set(line, shown)
    })
  }
  return line => removed.get(line)
}

/**
 * Keeps removed each line GitHub shows removed, by position.
 *
 * For a comment the controller rebuilds whole from the same finding on every
 * pass, where the Journal keeps no earlier source text. A line stays removed
 * when GitHub shows a removed line of the same shape at its position, so a
 * deny list change cannot publish it again.
 */
export function removalsByPosition(published: string): KeptRemovals {
  const publishedLines = published.includes(REMOVED_LINE) ? published.split('\n') : []
  return (line, index) => {
    const shown = publishedLines[index]
    return shown !== undefined && shown !== line && isRemovedFormOf(shown, line) ? shown : undefined
  }
}

/**
 * The redacted body with the removals GitHub already shows carried forward.
 *
 * A line the guard removes now keeps its current form, so its markers follow
 * the current deny list. A withheld body is already complete. A line that
 * only `carried` removes goes too: a kept removal can change the Markdown
 * around it, such as a removed fence opener that turns code into HTML.
 */
function withKeptRemovals(redacted: string, source: string, kept: KeptRemovals, carried: Guarded): string {
  const redactedLines = redacted.split('\n')
  const sourceLines = source.split('\n')
  if (redactedLines.length !== sourceLines.length)
    return redacted
  const carriedLines = carried.text.split('\n')
  return redactedLines.map((line, index) => {
    const sourceLine = sourceLines[index] ?? line
    if (line !== sourceLine)
      return line
    return kept(sourceLine, index) ?? (carried.removed.has(index) ? carriedLines[index] ?? line : line)
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
  return { text, send: reportingSend(guard, target, text, hits) }
}

/** Writes `body`, then reports `hits` once, after GitHub accepts the first write. */
function reportingSend<Body>(guard: PublicTextGuard, target: PublicTextTarget, body: Body, hits: readonly PrivateDetailHit[]) {
  let reported = false
  return async <T>(write: (body: Body) => Promise<T>, itemNumber?: (written: T) => number): Promise<T> => {
    const written = await write(body)
    if (!reported && hits.length > 0) {
      reported = true
      guard.report({ ...target, itemNumber: target.itemNumber ?? itemNumber?.(written) ?? null, hits })
    }
    return written
  }
}

/**
 * `kept` carries forward the removals an edit's comment already shows on GitHub.
 *
 * The guard removes what the intact source needs, so a kept removal never
 * hides a host from the rest of its tag. It also removes what the source with
 * the kept removals needs, because that is the Markdown GitHub renders. Only
 * hits outside the kept removals report, because GitHub accepted those
 * removals before.
 */
export function publicBody(guard: PublicTextGuard, target: PublicTextTarget, source: string, kept?: KeptRemovals): PublicBody {
  const detect = detectorsFor(guard.details)
  if (kept === undefined) {
    const redaction = guarded(detect, source)
    return { text: redaction.text, send: reportingSend(guard, target, redaction.text, redaction.hits) }
  }
  const carried = guarded(detect, source.split('\n').map((line, index) => kept(line, index) ?? line).join('\n'))
  const combined = carried.withheld ? carried.text : withKeptRemovals(guarded(detect, source).text, source, kept, carried)
  if (carried.withheld)
    return { text: combined, send: reportingSend(guard, target, combined, carried.hits) }
  const sourceLines = source.split('\n')
  const removed = new Set(combined.split('\n').flatMap((line, index) => line !== sourceLines[index] ? [index] : []))
  const checked = guarded(detect, source, removed)
  const text = checked.withheld
    ? checked.text
    : combined.split('\n').map((line, index) =>
        checked.removed.has(index) && !removed.has(index) ? removedLine(detect, sourceLines[index] ?? line) : line).join('\n')
  const hits = [...new Map([...carried.hits, ...checked.hits].map(hit => [`${hit._tag}:${hit.entry}`, hit])).values()]
  return { text, send: reportingSend(guard, target, text, hits) }
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
