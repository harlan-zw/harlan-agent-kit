import type { PackageReleaseRecord, PackageReleaseState, PackageReleaseStore, ReleaseNote, ReleaseNotePullRequest } from './package-release-store.ts'
import type { PackageReleaseOffer, PackageReleasePlan } from './package-release.ts'
import type { RepositoryMapping } from './types.ts'
import { PACKAGE_RELEASE_MARKER, renderManualMajorRelease, renderPackageRelease } from './package-release.ts'
import { canReleasePackages } from './repository-policy.ts'
import { automatedDisclosure } from './review-comment.ts'
import { cleanLine } from './text.ts'

export interface PackageReleaseSource {
  candidates: () => Promise<number[]>
  inspect: (number: number) => Promise<PackageReleaseOffer>
  comment: (number: number, body: string, commentId?: number) => Promise<number>
  prepare: (record: PackageReleaseRecord & { plan: Extract<PackageReleasePlan, { _tag: 'Available' }> }) => Promise<Extract<PackageReleaseState, { _tag: 'Prepared' | 'Publishing' | 'Blocked' }> | null>
  merge: (record: PackageReleaseRecord & { plan: Extract<PackageReleasePlan, { _tag: 'Available' }>, state: Extract<PackageReleaseState, { _tag: 'Prepared' }> }) => Promise<Extract<PackageReleaseState, { _tag: 'Publishing' | 'Blocked' }> | null>
  publish: (record: PackageReleaseRecord & { plan: Extract<PackageReleasePlan, { _tag: 'Available' }>, state: Extract<PackageReleaseState, { _tag: 'Publishing' }> }) => Promise<string | Extract<PackageReleaseState, { _tag: 'Blocked' }> | null>
  /** Merged pull requests in the published range, read before the release completes. */
  releaseNoteContext: (record: PackageReleaseRecord & { plan: Extract<PackageReleasePlan, { _tag: 'Available' }>, state: Extract<PackageReleaseState, { _tag: 'Publishing' }> }) => Promise<ReleaseNotePullRequest[]>
}

/**
 * Shows an Agent's draft as a quoted code block.
 *
 * The comment may use Harlan's token, so the draft must not render as his
 * Markdown. A code block shows mentions, issue references, links, and HTML as
 * plain text. Its fence is longer than any backtick run in the draft, so the
 * draft cannot close it. Every line is quoted, so none can start a release
 * control. Every line terminator becomes a newline first, because a multiline
 * pattern also breaks on `\r` and U+2028. An escaped comment opener keeps the
 * release marker unique.
 */
function quoteReleaseNote(text: string): string {
  const lines = text
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n')
    .replace(/<!--/g, '&lt;!--')
    .trim()
    .split('\n')
  const longestBackticks = Math.max(0, ...lines.flatMap(line => [...line.matchAll(/`+/g)].map(run => run[0].length)))
  const fence = '`'.repeat(Math.max(3, longestBackticks + 1))
  return [`${fence}markdown`, ...lines, fence].map(line => line.trim() === '' ? '>' : `> ${line}`).join('\n')
}

function releaseNoteStatus(note: ReleaseNote | null): string {
  if (note === null)
    return ''
  switch (note.state._tag) {
    case 'Queued':
    case 'Running':
      return '\n\nDrafting a release note.'
    case 'Drafted':
      return `\n\nRelease note draft for review. The GitHub release is unchanged.\n\n${quoteReleaseNote(note.state.text)}`
    case 'Failed':
      return `\n\nNo release note draft: ${cleanLine(note.state.reason)}`
  }
}

export function packageReleaseStatus(record: PackageReleaseRecord, note: ReleaseNote | null = null): string {
  if (record.state._tag === 'Available')
    return renderPackageRelease(record.plan)
  if (record.state._tag === 'AwaitingMerge')
    return renderPackageRelease(record.plan, true)
  const details: Record<Exclude<PackageReleaseState['_tag'], 'Available' | 'AwaitingMerge'>, string> = {
    Queued: 'Release requested. Waiting for passing default branch checks on the pinned release range.',
    Prepared: record.state._tag === 'Prepared' ? `Waiting for Review and required checks on #${record.state.pullRequestNumber}.` : '',
    Publishing: 'Waiting for GitHub Actions and npm publication.',
    Completed: record.state._tag === 'Completed' ? `Published [${record.plan.packageName}@${record.plan.version}](${record.state.url}).${releaseNoteStatus(note)}` : '',
    Blocked: record.state._tag === 'Blocked' ? `Action required: ${record.state.reason}` : '',
  }
  return `${PACKAGE_RELEASE_MARKER}\n${automatedDisclosure({ kind: 'status' })}\n\n${details[record.state._tag]}\n`
}

/** One pass advances durable Publications. A network error leaves the phase resumable. */
export async function reconcilePackageReleases(options: {
  repository: RepositoryMapping
  webhookReady: boolean
  store: PackageReleaseStore
  source: (assertLease: () => void) => PackageReleaseSource
  mayPublish: () => boolean
  now: () => number
  signal: AbortSignal
  /** Receives a failed comment write on a published release, which never stops the pass. */
  logger: { error: (message: string) => void }
}): Promise<{ _tag: 'Completed' } | { _tag: 'Paused' }> {
  const { repository, store, now, signal } = options
  if (!options.webhookReady || !canReleasePackages(repository))
    return { _tag: 'Completed' }
  const paused = { _tag: 'Paused' } as const
  if (!options.mayPublish())
    return paused
  const fence = store.claimPackageReleaseLease(repository.github, now())
  if (fence === null)
    return { _tag: 'Completed' }
  const assertLease = (): void => {
    signal.throwIfAborted()
    if (!options.mayPublish())
      throw paused
    if (!store.renewPackageReleaseLease(repository.github, fence, now()))
      throw new Error('The release lease expired.')
  }
  const source = options.source(assertLease)
  const policy = JSON.stringify(repository)
  const transition = (record: PackageReleaseRecord, state: PackageReleaseState, plan = record.plan): PackageReleaseRecord => {
    assertLease()
    if (!store.updatePackageRelease(record, state, fence, now(), plan))
      throw new Error('The release state changed.')
    return { ...record, state, plan }
  }
  const report = async (record: PackageReleaseRecord): Promise<void> => {
    const body = packageReleaseStatus(record, record.state._tag === 'Completed' ? store.getReleaseNote(record.repository, record.plan.version) : null)
    if (record.body === body)
      return
    assertLease()
    const commentId = await source.comment(record.pullRequestNumber, body, record.commentId)
    assertLease()
    if (!store.recordPackageReleaseComment(record, body, fence, now(), commentId))
      throw new Error('The release comment receipt changed.')
  }
  try {
    const records = store.listPackageReleases(repository.github)
    // Reconcile receipts before discovering offers. A lost response must not create a second version.
    for (let record of records) {
      assertLease()
      if (record.state._tag === 'Available')
        continue
      if (record.policy !== policy && !['Completed', 'Blocked'].includes(record.state._tag))
        record = transition(record, { _tag: 'Blocked', reason: 'The repository release policy changed.' })
      if (record.state._tag === 'AwaitingMerge') {
        const offer = await source.inspect(record.pullRequestNumber)
        assertLease()
        if (offer._tag === 'Unavailable' || offer._tag === 'ManualMajor') {
          record = transition(record, { _tag: 'Blocked', reason: offer.reason })
        }
        else if (!sameSelection(offer, record.plan)) {
          // A changed head or version needs a fresh checkbox selection.
          record = transition(record, { _tag: 'Available' }, offer)
        }
        else if (offer._tag === 'Available'
          && !store.listPackageReleases(repository.github).some(other => ['Queued', 'Prepared', 'Publishing'].includes(other.state._tag))) {
          record = transition(record, { _tag: 'Queued', requestedBy: record.state.requestedBy }, offer)
        }
      }
      if (record.state._tag === 'Queued' && record.plan._tag === 'Available') {
        const offer = await source.inspect(record.pullRequestNumber)
        assertLease()
        if (offer._tag !== 'Available' || !samePlan(offer, record.plan)) {
          record = transition(record, { _tag: 'Blocked', reason: offer._tag === 'ManualMajor' ? offer.reason : 'The release range changed. Request a new release after reviewing it.' })
        }
        else {
          const prepared = await source.prepare({ ...record, plan: record.plan })
          if (prepared !== null)
            record = transition(record, prepared)
        }
      }
      if (record.state._tag === 'Prepared' && record.plan._tag === 'Available') {
        const merged = await source.merge({ ...record, plan: record.plan, state: record.state })
        if (merged !== null)
          record = transition(record, merged)
      }
      if (record.state._tag === 'Publishing' && record.plan._tag === 'Available') {
        const publishing = { ...record, plan: record.plan, state: record.state }
        const url = await source.publish(publishing)
        if (typeof url === 'string') {
          // The draft is optional. A failed read leaves it to the git range and
          // never holds a published release. Pause and shutdown still stop the pass.
          const pullRequests = await source.releaseNoteContext(publishing).then(
            entries => ({ _tag: 'Available' as const, entries }),
            (error: unknown) => {
              if (error === paused || signal.aborted)
                throw error
              return { _tag: 'Unavailable' as const, reason: cleanLine(error instanceof Error ? error.message : 'The pull request read failed.') }
            },
          )
          record = transition(record, { _tag: 'Completed', url })
          store.queueReleaseNote({ repository: record.repository, pullRequestNumber: record.pullRequestNumber, packageName: publishing.plan.packageName, version: publishing.plan.version, tag: publishing.state.tag, previousTag: publishing.plan.previousTag, sha: publishing.state.sha, pullRequests })
        }
        else if (url !== null) {
          record = transition(record, url)
        }
      }
      if (record.state._tag === 'Completed') {
        // A published release can only gain its draft line here. A failed write
        // logs and retries next pass, so it never stops offers for this repository.
        const completed = record
        await report(completed).catch((error: unknown) => {
          if (error === paused || signal.aborted)
            throw error
          options.logger.error(`${repository.github}#${completed.pullRequestNumber}: the published release comment could not change: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      else {
        await report(record)
      }
    }
    if (store.listPackageReleases(repository.github).some(record => ['Queued', 'Prepared', 'Publishing'].includes(record.state._tag)))
      return { _tag: 'Completed' }
    const currentRecords = store.listPackageReleases(repository.github)
    const commands = store.listPackageReleaseCommands(repository.github)
    const manualReleases = new Set<number>()
    const candidates = new Set([...commands.map(command => command.pullRequestNumber), ...await source.candidates(), ...currentRecords.filter(record => record.state._tag === 'Available').map(record => record.pullRequestNumber)])
    for (const number of candidates) {
      assertLease()
      const existing = currentRecords.find(record => record.pullRequestNumber === number)
      if (existing !== undefined && existing.state._tag !== 'Available')
        continue
      const plan = await source.inspect(number)
      assertLease()
      if (plan._tag === 'ManualMajor') {
        manualReleases.add(number)
        if (existing !== undefined) {
          const blocked = transition(existing, { _tag: 'Blocked', reason: plan.reason })
          await report(blocked)
        }
        else {
          await source.comment(number, renderManualMajorRelease(plan))
        }
        continue
      }
      if (plan._tag === 'Unavailable') {
        if (existing !== undefined) {
          const blocked = transition(existing, { _tag: 'Blocked', reason: plan.reason })
          await report(blocked)
        }
        continue
      }
      const body = renderPackageRelease(plan)
      const commentId = existing?.body === body ? existing.commentId : await source.comment(number, body, existing?.commentId)
      assertLease()
      store.saveReleaseOffer({ repository: repository.github, pullRequestNumber: number, plan, commentId, body, policy })
    }
    for (const command of commands) {
      assertLease()
      const offer = store.listPackageReleases(repository.github).find(record => record.pullRequestNumber === command.pullRequestNumber)
      if (offer?.state._tag === 'Available' && (command.bump === 'auto' || command.bump === offer.plan.bump)) {
        store.requestPackageRelease({ ...command, commentId: offer.commentId, before: offer.body, commentAuthor: '', requestId: `comment:${command.commentId}`, selected: true })
      }
      else if (offer === undefined && !manualReleases.has(command.pullRequestNumber)) {
        await source.comment(command.pullRequestNumber, `${PACKAGE_RELEASE_MARKER}\n${automatedDisclosure({ kind: 'status' })}\n\nNo matching patch or minor release is available.\n`)
      }
      store.consumePackageReleaseCommand(command)
    }
  }
  catch (error) {
    // Pause is an expected interruption. Keep the durable phase for the next pass.
    if (error === paused)
      return paused
    const active = store.listPackageReleases(repository.github).find(record => ['Queued', 'Prepared', 'Publishing'].includes(record.state._tag))
    if (active !== undefined && !signal.aborted && options.mayPublish()) {
      const message = cleanLine(error instanceof Error ? error.message : 'The release request failed.')
      const body = `${PACKAGE_RELEASE_MARKER}\n${automatedDisclosure({ kind: 'status' })}\n\nRelease ${active.plan.version} is waiting: ${message}\nRetries keep this version.\n`
      if (active.body !== body) {
        await (async () => {
          assertLease()
          await source.comment(active.pullRequestNumber, body, active.commentId)
          assertLease()
          store.recordPackageReleaseComment(active, body, fence, now())
        })().catch((reportError: unknown) => {
          // Pause can stop this notification. The original failure still propagates below.
          if (reportError !== paused)
            throw reportError
        })
      }
    }
    throw error
  }
  finally {
    store.releasePackageReleaseLease(repository.github, fence)
  }
  return { _tag: 'Completed' }
}

function sameSelection(left: PackageReleasePlan, right: PackageReleasePlan): boolean {
  return left.headSha === right.headSha && left.version === right.version
    && left.previousTag === right.previousTag && left.previousVersion === right.previousVersion
    && left.bump === right.bump && left.packageName === right.packageName
}

function samePlan(left: PackageReleasePlan, right: PackageReleasePlan): boolean {
  return left._tag === 'Available' && right._tag === 'Available'
    && left.sourceSha === right.sourceSha && left.mergeSha === right.mergeSha && sameSelection(left, right)
}
