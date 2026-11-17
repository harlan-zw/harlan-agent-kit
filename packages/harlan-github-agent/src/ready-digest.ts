import type { JournalStore } from './store.ts'
import { cleanLine } from './text.ts'

const dayMilliseconds = 24 * 60 * 60 * 1000

/** Lines past this many are counted, not listed. */
export const READY_DIGEST_LIMIT = 50

export interface ReadyDigestLine {
  /** `owner/name#number`. */
  pullRequest: string
  /** Null unless the repository is known to be public, because the run log is public. */
  title: string | null
  daysSinceReady: number
}

/** The Monday list of pull requests that wait only for Harlan. */
export interface ReadyDigest {
  total: number
  pullRequests: ReadyDigestLine[]
  omitted: number
  markdown: string
}

function plural(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`
}

/**
 * Code spans keep GitHub from linking a reference or notifying a login.
 *
 * A plain `owner/name#number` or a title with `@login` would add a timeline
 * event to every listed pull request, or ping its author, each week.
 */
function codeSpan(text: string): string {
  return `\`${text.replaceAll('`', '\'')}\``
}

function renderLine(line: ReadyDigestLine): string {
  const title = line.title === null ? '' : ` ${codeSpan(line.title)}`
  return `- ${codeSpan(line.pullRequest)}${title}: ${plural(line.daysSinceReady, 'day')} since READY`
}

/**
 * Every open pull request whose current head is READY with passing CI, oldest READY first.
 *
 * The controller reads its own Review records, so no Agent reads GitHub for this.
 * A repository missing from `publicRepositories` counts as private and shows no title.
 */
export function collectReadyDigest(
  source: Pick<JournalStore, 'listReadyPullRequests'>,
  input: { now: Date, publicRepositories: ReadonlySet<string>, limit?: number },
): ReadyDigest {
  const publicNames = new Set([...input.publicRepositories].map(name => name.toLowerCase()))
  const ready = source.listReadyPullRequests()
  const pullRequests = ready.slice(0, input.limit ?? READY_DIGEST_LIMIT).map(pullRequest => ({
    pullRequest: `${pullRequest.repository}#${pullRequest.pullRequestNumber}`,
    title: publicNames.has(pullRequest.repository.toLowerCase()) ? cleanLine(pullRequest.title).replaceAll('`', '\'') : null,
    daysSinceReady: Math.max(0, Math.floor((input.now.getTime() - Date.parse(pullRequest.readyAt)) / dayMilliseconds)),
  }))
  const omitted = ready.length - pullRequests.length
  const markdown = ready.length === 0
    ? 'No pull request is READY with passing CI.'
    : [
        `${plural(ready.length, 'pull request')} ${ready.length === 1 ? 'is' : 'are'} READY with passing CI, oldest first.`,
        '',
        ...pullRequests.map(renderLine),
        ...omitted === 0 ? [] : ['', `${plural(omitted, 'more pull request')} not listed.`],
        ...pullRequests.some(line => line.title === null) ? ['', 'A private repository shows no title, because this log is public.'] : [],
      ].join('\n')
  return { total: ready.length, pullRequests, omitted, markdown }
}
