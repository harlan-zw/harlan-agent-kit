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

/** A root with fewer segments would redact paths that every Linux host shares. */
function privateRoot(path: string): string | null {
  if (!isAbsolute(path))
    return null
  const root = normalize(path).replace(/\/+$/, '')
  return root.split('/').filter(Boolean).length >= 2 ? root : null
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

export const PRIVATE_PATH_PLACEHOLDER = '[private path]'
export const PRIVATE_LINK_PLACEHOLDER = '[private link]'
const PLACEHOLDER_PATTERN = /\[private (?:path|link)\]/

function escape(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Matches one literal entry in plain text and in its entity-encoded spelling. */
function literalPattern(value: string): string {
  return [...value].map(character => ENTITY_ENCODED_CHARACTERS.includes(character)
    ? `(?:${escape(character)}|&#${character.charCodeAt(0)};)`
    : escape(character)).join('')
}

/** Characters a path or URL token runs over. Whitespace, quotes, and Markdown delimiters end it. */
const TOKEN = String.raw`(?:(?!&#(?:96|60|62|91|93);)[^\s'"\`()<>[\]{}|])`
/**
 * Where an entry ends. A full stop that ends the sentence counts, so
 * `~/scratch.` matches, while `~/scratchpad`, `~/scratch.txt`, and an encoded
 * `~/scratch_old` do not.
 */
const TOKEN_END = String.raw`(?![\w-]|\.[\w-]|&#95;)`
/** Sentence punctuation after a token belongs to the sentence. */
const TRAILING_PUNCTUATION = /[.,:;!?]+$/
/**
 * A URL authority: any scheme, or none, then `//`. A host after it is the
 * URL's own host and is private. A host after a single slash is a path
 * segment of some other URL, so it stays.
 */
const AUTHORITY = String.raw`(?:(?<![\w.+-])[a-z][a-z\d+.-]{0,15}:)?(?<![\w./-])//`
/** User information belongs to the private URL, including its entity-encoded at sign. */
const USER_INFORMATION = String.raw`(?:[^\s/<>"'\x60]*(?:@|&#64;))?`

interface Matchers {
  path: RegExp | null
  link: RegExp | null
}

function longestFirst(values: readonly string[]): string[] {
  return [...values].sort((left, right) => right.length - left.length)
}

/**
 * Patterns use literal deny list entries. An authority ends at a slash or
 * delimiter, so matching user information scans only that authority.
 */
function matchers(details: PrivateDetails): Matchers {
  const paths = longestFirst(details.paths).map(literalPattern)
  const hosts = longestFirst(details.hosts).map(literalPattern)
  return {
    path: paths.length === 0
      ? null
      : new RegExp(String.raw`(?<![\w.~$-])(?:${paths.join('|')})(?:/${TOKEN}*)?${TOKEN_END}`, 'g'),
    // A bare host that a slash precedes sits inside a public URL's path, so it never starts a match.
    link: hosts.length === 0
      ? null
      : new RegExp(String.raw`(?:${AUTHORITY}${USER_INFORMATION}|(?<![\w./@-]))(?:[\w-]{1,63}\.){0,8}(?:${hosts.join('|')})(?::\d{1,5})?(?:[/?#]${TOKEN}*)?${TOKEN_END}`, 'gi'),
  }
}

function entryFor(details: PrivateDetails, hit: PrivateDetailHit['_tag'], token: string): string {
  const text = decodeEntities(token)
  if (hit === 'Link') {
    const authority = text.replace(/^(?:[a-z][a-z\d+.-]*:)?\/\//i, '').split(/[/?#]/)[0] ?? text
    const host = authority.slice(authority.lastIndexOf('@') + 1).split(':')[0]!.toLowerCase()
    return details.hosts.find(entry => host === entry || host.endsWith(`.${entry}`)) ?? host
  }
  return longestFirst(details.paths).find(entry => text === entry || text.startsWith(`${entry}/`)) ?? text
}

interface Span {
  start: number
  end: number
}

/**
 * The whole Markdown link or autolink whose target is the token at `start`.
 *
 * Its label alone would read as a broken link, so the link goes as a whole.
 * Every search stays on the token's line. Redaction consumes the scanned span.
 */
function linkSpan(text: string, start: number, end: number): Span | null {
  const encoded = text.slice(start - 5, start) === '&#60;'
  const angleLength = encoded ? 5 : text[start - 1] === '<' ? 1 : 0
  const targetStart = start - angleLength
  const labelClose = text.slice(targetStart - 6, targetStart) === '&#93;(' ? '&#93;(' : ']('
  if (text.slice(targetStart - labelClose.length, targetStart) !== labelClose) {
    const angleClose = encoded ? '&#62;' : '>'
    return angleLength > 0 && text.startsWith(angleClose, end) ? { start: targetStart, end: end + angleClose.length } : null
  }
  const labelEnd = targetStart - labelClose.length
  const labelOpen = labelClose === '](' ? '[' : '&#91;'
  const labelStart = text.lastIndexOf(labelOpen, labelEnd - 1)
  const label = text.slice(labelStart + labelOpen.length, labelEnd)
  const startOfSpan = labelStart === -1 || label.includes('\n') || label.includes(labelClose.slice(0, -1))
    ? targetStart
    : text[labelStart - 1] === '!' ? labelStart - 1 : labelStart
  let depth = 1
  let quote: string | null = null
  let angle = false
  for (let index = targetStart; index < text.length; index++) {
    const character = text[index]!
    if (character === '\n')
      return { start: startOfSpan, end: index }
    if (character === '\\') {
      index++
      continue
    }
    if (text.startsWith('&#60;', index) || text.startsWith('&#62;', index)) {
      angle = text.startsWith('&#60;', index)
      index += 4
      continue
    }
    if (quote !== null) {
      if (character === quote)
        quote = null
      continue
    }
    if (character === '<')
      angle = true
    else if (character === '>')
      angle = false
    else if (!angle && (character === '"' || character === '\'') && /\s/.test(text[index - 1] ?? ''))
      quote = character
    else if (!angle && character === '(')
      depth++
    else if (!angle && character === ')' && --depth === 0)
      return { start: startOfSpan, end: index + 1 }
  }
  // An unclosed private destination has no safe public suffix on this line.
  return { start: startOfSpan, end: text.length }
}

function redactTokens(text: string, pattern: RegExp, tag: PrivateDetailHit['_tag'], details: PrivateDetails, hits: PrivateDetailHit[]): string {
  const placeholder = tag === 'Link' ? PRIVATE_LINK_PLACEHOLDER : PRIVATE_PATH_PLACEHOLDER
  let output = ''
  let cursor = 0
  pattern.lastIndex = 0
  for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
    const start = found.index
    const end = start + found[0].length
    if (start < cursor)
      continue
    const link = linkSpan(text, start, end)
    if (link !== null && link.start >= cursor) {
      output += `${text.slice(cursor, link.start)}${placeholder}`
      cursor = link.end
      pattern.lastIndex = Math.max(pattern.lastIndex, link.end)
      hits.push({ _tag: tag, entry: entryFor(details, tag, found[0]) })
      continue
    }
    // An entity's closing semicolon belongs to the token, not to the sentence.
    const punctuation = /&#\d{2,3};$/.test(found[0]) ? '' : found[0].match(TRAILING_PUNCTUATION)?.[0] ?? ''
    const token = found[0].slice(0, found[0].length - punctuation.length)
    output += `${text.slice(cursor, start)}${placeholder}`
    cursor = start + token.length
    hits.push({ _tag: tag, entry: entryFor(details, tag, token) })
  }
  return output + text.slice(cursor)
}

/**
 * Quoted and inline code paths may hold spaces, which end a plain token.
 *
 * Inside inline code, a private path runs to the closing backtick. Inside
 * quotes, only content that opens with a private path counts, so a quotation
 * that merely mentions one keeps its other words. The native review encodes
 * a backtick as `&#96;`, so that spelling delimits inline code too. An
 * unquoted path with spaces stays out of reach: nothing marks where it ends.
 */
function redactDelimitedPaths(text: string, pattern: RegExp, details: PrivateDetails, hits: PrivateDetailHit[]): string {
  const delimited: Array<{ span: RegExp, delimiter: string, anywhere: boolean }> = [
    { span: /`([^`\n]{1,4096})`/g, delimiter: '`', anywhere: true },
    { span: /&#96;((?:(?!&#96;)[^\n]){1,4096})&#96;/g, delimiter: '&#96;', anywhere: true },
    { span: /"([^"\n]{1,4096})"/g, delimiter: '"', anywhere: false },
    { span: /\B'([^'\n]{1,4096})'\B/g, delimiter: '\'', anywhere: false },
  ]
  return delimited.reduce((current, { span, delimiter, anywhere }) => current.replace(span, (whole, content: string) => {
    pattern.lastIndex = 0
    const found = pattern.exec(content)
    if (found === null || (!anywhere && found.index !== 0))
      return whole
    hits.push({ _tag: 'Path', entry: entryFor(details, 'Path', content.slice(found.index).split(/\s/)[0] ?? '') })
    return `${delimiter}${content.slice(0, found.index)}${PRIVATE_PATH_PLACEHOLDER}${delimiter}`
  }), text)
}

/**
 * Replaces every private path and link in one body with a placeholder.
 *
 * Pure, so a writer can compare before it decides to write. A Markdown link to
 * a private target goes as a whole, and a public link keeps every character.
 */
export function redactPrivateDetails(text: string, details: PrivateDetails): Redaction {
  const match = matchers(details)
  const hits: PrivateDetailHit[] = []
  let redacted = text
  if (match.path !== null)
    redacted = redactDelimitedPaths(redacted, match.path, details, hits)
  if (match.link !== null)
    redacted = redactTokens(redacted, match.link, 'Link', details, hits)
  if (match.path !== null)
    redacted = redactTokens(redacted, match.path, 'Path', details, hits)
  return { text: redacted, hits }
}

/** The most placeholders one published body may carry before a comparison gives up. */
const MAXIMUM_COMPARED_PLACEHOLDERS = 200

/**
 * Whether GitHub's `published` body is `source` after a redaction.
 *
 * It holds whatever deny list the writer used, so a comment written before a
 * configuration change still matches the Journal text that produced it. Each
 * placeholder stands for some text on one line. Equal text always matches.
 */
export function isPublishedForm(published: string, source: string): boolean {
  if (published === source)
    return true
  const segments = published.split(new RegExp(PLACEHOLDER_PATTERN.source, 'g'))
  if (segments.length === 1 || segments.length > MAXIMUM_COMPARED_PLACEHOLDERS + 1)
    return false
  const first = segments[0]!
  const last = segments.at(-1)!
  if (!source.startsWith(first))
    return false
  let position = first.length
  for (const segment of segments.slice(1, -1)) {
    const index = source.indexOf(segment, position + 1)
    if (index === -1 || source.slice(position, index).includes('\n'))
      return false
    position = index + segment.length
  }
  const tail = source.length - last.length
  return tail > position && source.endsWith(last) && !source.slice(position, tail).includes('\n')
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
 * reports the redaction and then writes, so a report always means a write:
 * a no-op, a lost acknowledgment, or a refused authorization reports nothing.
 */
export interface PublicBody {
  text: string
  send: <T>(write: (body: string) => T) => T
}

export function publicBody(guard: PublicTextGuard, target: PublicTextTarget, source: string): PublicBody {
  const redaction = redactPrivateDetails(source, guard.details)
  let reported = false
  return {
    text: redaction.text,
    send: (write) => {
      if (!reported && redaction.hits.length > 0) {
        reported = true
        guard.report({ ...target, hits: redaction.hits })
      }
      return write(redaction.text)
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
