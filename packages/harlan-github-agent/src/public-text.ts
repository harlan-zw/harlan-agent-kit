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
  /** Directory prefixes, absolute or `~/` relative. A path at or under one is private. */
  paths: readonly string[]
  /** Host names. A link to one, or to a subdomain of one, is private. */
  hosts: readonly string[]
}

/** The roots and hosts this host and configuration use. */
export interface PrivateDetailSources {
  /** The controller home. Only `scratch` and `notes` under it are private, not the home itself. */
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

export function privateDetailsFor(sources: PrivateDetailSources): PrivateDetails {
  const home = privateRoot(sources.home)
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
    paths: [...new Set([...roots, ...PRIVATE_HOME_DIRECTORIES.flatMap(name => [`~/${name}`, `$HOME/${name}`])])],
    hosts: [...new Set([NOTES_HOST, DASHBOARD_LOCAL_HOST, ...hosts])],
  }
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

function escape(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A native review entity-encodes `~`, so the tilde form matches its entity too. */
function pathAlternative(path: string): string {
  return path.startsWith('~/') ? `(?:~|&#126;)${escape(path.slice(1))}` : escape(path)
}

/** Characters a path or URL token runs over. Whitespace, quotes, and Markdown delimiters end it. */
const TOKEN_CHARACTERS = String.raw`[^\s'"\`()<>[\]{}|]`
/**
 * Where an entry ends. A full stop that ends the sentence counts, so
 * `~/scratch.` matches, while `~/scratchpad` and `~/scratch.txt` do not.
 */
const TOKEN_END = String.raw`(?![\w-]|\.[\w-])`
/** Sentence punctuation after a token belongs to the sentence. */
const TRAILING_PUNCTUATION = /[.,:;!?]+$/

interface Matchers {
  path: RegExp | null
  link: RegExp | null
  markdownLink: RegExp
  autolink: RegExp
}

function matchers(details: PrivateDetails): Matchers {
  const paths = [...details.paths].sort((left, right) => right.length - left.length).map(pathAlternative)
  const hosts = [...details.hosts].sort((left, right) => right.length - left.length).map(escape)
  return {
    path: paths.length === 0
      ? null
      : new RegExp(String.raw`(?<![\w.~$-])(?:${paths.join('|')})(?:/${TOKEN_CHARACTERS}*)?${TOKEN_END}`, 'g'),
    link: hosts.length === 0
      ? null
      : new RegExp(String.raw`(?<![\w.-])(?:https?://)?(?:[\w-]+\.)*(?:${hosts.join('|')})(?::\d+)?(?:[/?#]${TOKEN_CHARACTERS}*)?${TOKEN_END}`, 'gi'),
    markdownLink: /!?\[[^\]\n]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"\n]*")?\s*\)/g,
    autolink: /<(https?:\/\/[^\s>]+)>/g,
  }
}

function entryFor(details: PrivateDetails, hit: PrivateDetailHit['_tag'], token: string): string {
  if (hit === 'Link') {
    const host = token.replace(/^https?:\/\//i, '').split(/[/:?#]/)[0]?.toLowerCase() ?? token
    return details.hosts.find(entry => host === entry || host.endsWith(`.${entry}`)) ?? host
  }
  const path = token.replace(/^&#126;/, '~')
  return [...details.paths].sort((left, right) => right.length - left.length).find(entry => path === entry || path.startsWith(`${entry}/`)) ?? token
}

/**
 * Replaces every private path and link in one body with a placeholder.
 *
 * Pure, so the publish boundary and every comparison with a published body
 * compute the same text. A Markdown link to a private target goes as a whole,
 * because its label alone would read as a broken link.
 */
export function redactPrivateDetails(text: string, details: PrivateDetails): Redaction {
  const match = matchers(details)
  const hits: PrivateDetailHit[] = []
  const privateTarget = (target: string): PrivateDetailHit | null => {
    for (const [tag, pattern] of [['Link', match.link], ['Path', match.path]] as const) {
      if (pattern === null)
        continue
      pattern.lastIndex = 0
      const found = pattern.exec(target)
      if (found !== null)
        return { _tag: tag, entry: entryFor(details, tag, found[0]) }
    }
    return null
  }
  const whole = (link: string, target: string): string => {
    const hit = privateTarget(target)
    if (hit === null)
      return link
    hits.push(hit)
    return hit._tag === 'Link' ? PRIVATE_LINK_PLACEHOLDER : PRIVATE_PATH_PLACEHOLDER
  }
  const token = (tag: PrivateDetailHit['_tag'], placeholder: string) => (value: string): string => {
    const punctuation = value.match(TRAILING_PUNCTUATION)?.[0] ?? ''
    const detail = value.slice(0, value.length - punctuation.length)
    hits.push({ _tag: tag, entry: entryFor(details, tag, detail) })
    return `${placeholder}${punctuation}`
  }
  let redacted = text
    .replace(match.markdownLink, whole)
    .replace(match.autolink, whole)
  if (match.link !== null)
    redacted = redacted.replace(match.link, token('Link', PRIVATE_LINK_PLACEHOLDER))
  if (match.path !== null)
    redacted = redacted.replace(match.path, token('Path', PRIVATE_PATH_PLACEHOLDER))
  return { text: redacted, hits }
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
 * The body GitHub receives. A redaction is reported, never silent.
 *
 * Call it where a writer derives the body it sends. A comparison with what
 * GitHub holds uses `redactPrivateDetails` alone, so it reports nothing twice.
 */
export function guardPublicText(guard: PublicTextGuard, target: PublicTextTarget, text: string): string {
  const redacted = redactPrivateDetails(text, guard.details)
  reportRedaction(guard, target, redacted)
  return redacted.text
}

/**
 * Reports a redaction a writer computed itself.
 *
 * For a writer that a sync calls on every pass: it redacts, returns early when
 * GitHub already holds that text, and reports only before a real write. An
 * Incident that a no-op raised again would reopen after Harlan resolved it.
 */
export function reportRedaction(guard: PublicTextGuard, target: PublicTextTarget, redaction: Redaction): void {
  if (redaction.hits.length > 0)
    guard.report({ ...target, hits: redaction.hits })
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
