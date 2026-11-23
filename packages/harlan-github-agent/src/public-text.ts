import type { JournalStore } from './store.ts'
import { basename, dirname, isAbsolute, normalize } from 'node:path'
import { decodeHTML } from 'entities'

/**
 * Private details that no public body may carry.
 *
 * Built once from configuration and the host, never from a blanket pattern.
 * A finding may legitimately describe `localhost`, `~/.config`, or a config
 * path under the controller home, so only these exact roots and hosts count.
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
  if (home === null || !root.startsWith(`${home}/`))
    return [root]
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
    paths: [...new Set(roots.flatMap(root => spellings(root, home)))],
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
function detector(details: PrivateDetails, spell: (entry: string) => string, end: string): Detector {
  const entries = new Map(details.paths.map(entry => [spell(entry), entry]))
  const hosts = new Map(details.hosts.map(host => [spell(host).toLowerCase(), host]))
  const longestFirst = (values: Iterable<string>) => [...values].filter(Boolean).sort((left, right) => right.length - left.length).map(escape)
  const paths = longestFirst(entries.keys())
  const names = longestFirst(hosts.keys())
  return {
    entries,
    hosts,
    path: paths.length === 0 ? null : new RegExp(String.raw`(?<![\w.~$-])(?:${paths.join('|')})${end}`, 'g'),
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

/** An inline HTML tag, such as `<b>` or `</code>`. Its text renders, the tag does not. It never spans a line. */
const INLINE_TAG = /<\/?[a-z][a-z\d-]*(?:[ \t][^<>\n]*)?\/?>/gi
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
    .replaceAll(INLINE_TAG, '')
    .replaceAll(FORMATTING, '')
    .replaceAll(/\/\.(?=\/)/g, '')
    .replaceAll(/(?<!:)\/{2,}/g, '/')
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
}

function detectorsFor(details: PrivateDetails): Detectors {
  return {
    raw: detector(details, entry => entry, RAW_ENTRY_END),
    decoded: detector(details, entry => entry, ENTRY_END),
    normalised: detector(details, entry => entry.replaceAll(FORMATTING, ''), ENTRY_END),
  }
}

/**
 * Every private detail in `text`, with the index of its line. It matches the
 * raw text, the text as GitHub renders it, and that text without Markdown
 * formatting. Every view keeps the line breaks of `text`.
 */
function detailsIn(detect: Detectors, text: string): Array<{ line: number, hit: PrivateDetailHit }> {
  const decoded = aligned(text, decodeAll)
  const views: Array<[Detector, string]> = [[detect.raw, text], [detect.decoded, decoded], [detect.normalised, aligned(decoded, normalise)]]
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
  const markers = htmlComments(line).filter(marker => detailsIn(detect, marker).length === 0)
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
  const detect = detectorsFor(details)
  const found = detailsIn(detect, text)
  if (found.length === 0)
    return { text, hits: [] }
  const affected = new Set(found.map(({ line }) => line))
  const hits = [...new Map(found.map(({ line, hit }) => [`${line}:${hit._tag}:${hit.entry}`, hit])).values()]
  return {
    text: text.split('\n').map((line, index) => affected.has(index) ? `${removedLine(detect, line)}${line.endsWith('\r') ? '\r' : ''}` : line).join('\n'),
    hits,
  }
}

/** Whether `line` is what the guard writes in place of `source`, under any deny list. */
function isRemovedFormOf(line: string, source: string): boolean {
  const structure = LINE_STRUCTURE.exec(source)?.[0] ?? ''
  if (!line.startsWith(`${structure}${REMOVED_LINE}`))
    return false
  const rest = line.slice(structure.length + REMOVED_LINE.length)
  const markers = htmlComments(rest)
  const sourceMarkers = htmlComments(source)
  return markers.reduce((remainder, marker) => remainder.replace(marker, ''), rest).trim() === '' && markers.every(marker => sourceMarkers.includes(marker))
}

/**
 * Whether GitHub's `published` body is `source` after the guard removed lines.
 *
 * It holds whatever deny list the writer used, so a comment written before a
 * configuration change still matches the Journal text that produced it. Every
 * other line must be equal, and the line count must not change.
 */
export function isPublishedForm(published: string, source: string): boolean {
  if (published === source)
    return true
  const publishedLines = published.split('\n')
  const sourceLines = source.split('\n')
  return publishedLines.length === sourceLines.length
    && publishedLines.every((line, index) => line === sourceLines[index] || isRemovedFormOf(line, sourceLines[index] ?? ''))
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

export function publicBody(guard: PublicTextGuard, target: PublicTextTarget, source: string): PublicBody {
  const redaction = redactPrivateDetails(source, guard.details)
  let reported = false
  return {
    text: redaction.text,
    send: async (write, itemNumber) => {
      const written = await write(redaction.text)
      if (!reported && redaction.hits.length > 0) {
        reported = true
        guard.report({ ...target, itemNumber: target.itemNumber ?? itemNumber?.(written) ?? null, hits: redaction.hits })
      }
      return written
    },
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
