import type { JournalStore } from './store.ts'
import { dirname, isAbsolute, normalize } from 'node:path'

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
  return [root, `~/${rest}`, `$HOME/${rest}`]
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
 * One list serves the encoder and the matcher, so a private path cannot slip
 * through the publish boundary in its encoded spelling.
 */
const ENTITY_ENCODED_CHARACTERS = '&<>@[]#`*_~'

export function encodeEntities(value: string): string {
  return [...value].map(character => ENTITY_ENCODED_CHARACTERS.includes(character) ? `&#${character.charCodeAt(0)};` : character).join('')
}

function decodeEntities(value: string): string {
  return value.replaceAll(/&#(\d{2,3});/g, (entity, code: string) => {
    const character = String.fromCharCode(Number(code))
    return ENTITY_ENCODED_CHARACTERS.includes(character) ? character : entity
  })
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
/** Markers that parsers read. A removed line keeps each one that names no private detail. */
const HTML_COMMENT = /<!--.*?-->/g

function escape(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Matches one literal entry in plain text and in its entity-encoded spelling. */
function literalPattern(value: string): string {
  return [...value].map(character => ENTITY_ENCODED_CHARACTERS.includes(character)
    ? `(?:${escape(character)}|&#${character.charCodeAt(0)};)`
    : escape(character)).join('')
}

/**
 * Where an entry ends. A full stop that ends the sentence counts, so
 * `~/scratch.` matches, while `~/scratchpad`, `~/scratch.txt`, and an encoded
 * `~/scratch_old` do not.
 */
const ENTRY_END = String.raw`(?![\w-]|\.[\w-]|&#95;)`
/** Where a host ends. A host name holds no underscore, so `__host__` emphasis still matches. */
const HOST_END = String.raw`(?![a-z\d-]|\.[a-z\d-])`
/**
 * A URL authority: any scheme, or none, then `//`. A host after it is the
 * URL's own host and is private. A bare host after a single slash is a path
 * segment of some other URL, so it stays.
 */
const AUTHORITY = String.raw`(?:(?<![\w.+-])[a-z][a-z\d+.-]{0,15}:)?(?<![\w./-])//`

interface Detector {
  details: PrivateDetails
  /** Entries longest first, so a nested root names itself. */
  paths: string[]
  path: RegExp | null
  link: RegExp | null
}

/**
 * Every pattern starts from a literal deny list entry, and every repetition is
 * bounded, so one scan does bounded work per character of the body.
 */
function detector(details: PrivateDetails): Detector {
  const paths = [...details.paths].sort((left, right) => right.length - left.length)
  const hosts = [...details.hosts].sort((left, right) => right.length - left.length).map(literalPattern)
  return {
    details,
    paths,
    path: paths.length === 0
      ? null
      : new RegExp(String.raw`(?<![\w.~$-])(?:${paths.map(literalPattern).join('|')})${ENTRY_END}`, 'g'),
    // User information before an at sign is part of the line, so it goes with it.
    link: hosts.length === 0
      ? null
      : new RegExp(String.raw`(?:${AUTHORITY}|(?<![\w./-]))(?:[\w-]{1,63}\.){0,8}(?:${hosts.join('|')})${HOST_END}`, 'gi'),
  }
}

function entryFor(detect: Detector, hit: PrivateDetailHit['_tag'], matched: string): string {
  const text = decodeEntities(matched)
  if (hit === 'Path')
    return detect.paths.find(entry => text === entry) ?? text
  const host = text.replace(/^(?:[a-z][a-z\d+.-]*:)?\/\//i, '').toLowerCase()
  return detect.details.hosts.find(entry => host === entry || host.endsWith(`.${entry}`)) ?? host
}

/** Every private detail in `text`, with its offset. No pattern can match across a line break. */
function findDetails(detect: Detector, text: string): Array<{ index: number, hit: PrivateDetailHit }> {
  return (['Link', 'Path'] as const).flatMap((tag) => {
    const pattern = tag === 'Link' ? detect.link : detect.path
    return pattern === null ? [] : [...text.matchAll(pattern)].map(found => ({ index: found.index ?? 0, hit: { _tag: tag, entry: entryFor(detect, tag, found[0]) } }))
  })
}

function lineHits(detect: Detector, line: string): PrivateDetailHit[] {
  return findDetails(detect, line).map(({ hit }) => hit)
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
function removedLine(detect: Detector, line: string): string {
  const structure = LINE_STRUCTURE.exec(line)?.[0] ?? ''
  const markers = (line.match(HTML_COMMENT) ?? []).filter(marker => lineHits(detect, marker).length === 0)
  return [`${structure}${REMOVED_LINE}`, ...markers].join(' ')
}

/**
 * Replaces every line that names a private detail with `REMOVED_LINE`.
 *
 * Pure, so a writer can compare before it decides to write. A line that names
 * nothing private keeps every character, so a public link whose path happens
 * to contain a private host name stays whole.
 */
export function redactPrivateDetails(text: string, details: PrivateDetails): Redaction {
  const detect = detector(details)
  // One scan of the whole body per pattern, so many short lines cost no more than one long one.
  const found = findDetails(detect, text)
  if (found.length === 0)
    return { text, hits: [] }
  const lines = text.split('\n')
  const starts: number[] = []
  lines.reduce((offset, line) => {
    starts.push(offset)
    return offset + line.length + 1
  }, 0)
  const affected = new Set(found.map(({ index }) => lineAt(starts, index)))
  return {
    text: lines.map((line, index) => affected.has(index) ? `${removedLine(detect, line)}${line.endsWith('\r') ? '\r' : ''}` : line).join('\n'),
    hits: found.map(({ hit }) => hit),
  }
}

/** Whether `line` is what the guard writes in place of `source`, under any deny list. */
function isRemovedFormOf(line: string, source: string): boolean {
  const structure = LINE_STRUCTURE.exec(source)?.[0] ?? ''
  if (!line.startsWith(`${structure}${REMOVED_LINE}`))
    return false
  const rest = line.slice(structure.length + REMOVED_LINE.length)
  const markers: string[] = source.match(HTML_COMMENT) ?? []
  return rest.replaceAll(HTML_COMMENT, '').trim() === '' && (rest.match(HTML_COMMENT) ?? []).every(marker => markers.includes(marker))
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
  send: <T>(write: (body: string) => Promise<T>) => Promise<T>
}

export function publicBody(guard: PublicTextGuard, target: PublicTextTarget, source: string): PublicBody {
  const redaction = redactPrivateDetails(source, guard.details)
  let reported = false
  return {
    text: redaction.text,
    send: async (write) => {
      const written = await write(redaction.text)
      if (!reported && redaction.hits.length > 0) {
        reported = true
        guard.report({ ...target, hits: redaction.hits })
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

/** Records each redaction as an Incident on its repository. Only a person resolves it. */
export function createPublicTextGuard(options: {
  details: PrivateDetails
  store: Pick<JournalStore, 'recordIncident'>
  now: () => Date
}): PublicTextGuard {
  return {
    details: options.details,
    report: (leak) => {
      options.store.recordIncident({
        scope: { _tag: 'Repository', repository: leak.repository },
        kind: 'private_detail',
        severity: 'warning',
        operation: PRIVATE_DETAIL_OPERATION,
        message: privateDetailIncidentMessage(leak),
        recovery: { _tag: 'ActionRequired' },
        at: options.now().toISOString(),
      })
    },
  }
}
