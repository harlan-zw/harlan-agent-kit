import type { PackageReleaseRecord, PackageReleaseState, PackageReleaseStore } from './package-release-store.ts'
import type { PackageReleaseOffer, PackageReleasePlan } from './package-release.ts'
import type { RepositoryMapping } from './types.ts'
import { PACKAGE_RELEASE_MARKER, renderPackageRelease } from './package-release.ts'
import { automatedDisclosure } from './review-comment.ts'
import { cleanLine } from './text.ts'

export interface PackageReleaseSource {
  candidates: () => Promise<number[]>
  inspect: (number: number) => Promise<PackageReleaseOffer>
  comment: (number: number, body: string, commentId?: number) => Promise<number>
  prepare: (record: PackageReleaseRecord) => Promise<Extract<PackageReleaseState, { _tag: 'Prepared' | 'Publishing' | 'Blocked' }> | null>
  merge: (record: PackageReleaseRecord & { state: Extract<PackageReleaseState, { _tag: 'Prepared' }> }) => Promise<Extract<PackageReleaseState, { _tag: 'Publishing' | 'Blocked' }> | null>
  publish: (record: PackageReleaseRecord & { state: Extract<PackageReleaseState, { _tag: 'Publishing' }> }) => Promise<string | Extract<PackageReleaseState, { _tag: 'Blocked' }> | null>
}

export function packageReleaseStatus(record: PackageReleaseRecord): string {
  if (record.state._tag === 'Available')
    return renderPackageRelease(record.plan)
  const details: Record<Exclude<PackageReleaseState['_tag'], 'Available'>, string> = {
    Queued: 'Release requested. Checking the pinned release range.',
    Prepared: record.state._tag === 'Prepared' ? `Waiting for Review and required checks on #${record.state.pullRequestNumber}.` : '',
    Publishing: 'Waiting for GitHub Actions and npm publication.',
    Completed: record.state._tag === 'Completed' ? `Published [${record.plan.packageName}@${record.plan.version}](${record.state.url}).` : '',
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
  now: () => number
  signal: AbortSignal
}): Promise<void> {
  const { repository, store, now, signal } = options
  if (!options.webhookReady || !repository.enabled || repository.release === undefined || repository.ownership !== 'owned')
    return
  const fence = store.claimPackageReleaseLease(repository.github, now())
  if (fence === null)
    return
  const assertLease = (): void => {
    signal.throwIfAborted()
    if (!store.renewPackageReleaseLease(repository.github, fence, now()))
      throw new Error('The release lease expired.')
  }
  const source = options.source(assertLease)
  const policy = JSON.stringify(repository)
  const transition = (record: PackageReleaseRecord, state: PackageReleaseState): PackageReleaseRecord => {
    assertLease()
    if (!store.updatePackageRelease(record, state, fence, now()))
      throw new Error('The release state changed.')
    return { ...record, state }
  }
  const report = async (record: PackageReleaseRecord): Promise<void> => {
    const body = packageReleaseStatus(record)
    if (record.body === body)
      return
    await source.comment(record.pullRequestNumber, body, record.commentId)
    assertLease()
    if (!store.recordPackageReleaseComment(record, body, fence, now()))
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
      if (record.state._tag === 'Queued') {
        const offer = await source.inspect(record.pullRequestNumber)
        if (offer._tag !== 'Available' || !samePlan(offer, record.plan)) {
          record = transition(record, { _tag: 'Blocked', reason: 'The release range changed. Request a new release after reviewing it.' })
        }
        else {
          const prepared = await source.prepare(record)
          if (prepared !== null)
            record = transition(record, prepared)
        }
      }
      if (record.state._tag === 'Prepared') {
        const merged = await source.merge({ ...record, state: record.state })
        if (merged !== null)
          record = transition(record, merged)
      }
      if (record.state._tag === 'Publishing') {
        const url = await source.publish({ ...record, state: record.state })
        if (url !== null)
          record = transition(record, typeof url === 'string' ? { _tag: 'Completed', url } : url)
      }
      await report(record)
    }
    if (store.listPackageReleases(repository.github).some(record => ['Queued', 'Prepared', 'Publishing'].includes(record.state._tag)))
      return
    const commands = store.listPackageReleaseCommands(repository.github)
    const candidates = new Set([...commands.map(command => command.pullRequestNumber), ...await source.candidates(), ...records.filter(record => record.state._tag === 'Available').map(record => record.pullRequestNumber)])
    for (const number of candidates) {
      assertLease()
      const existing = records.find(record => record.pullRequestNumber === number)
      if (existing !== undefined && existing.state._tag !== 'Available')
        continue
      const plan = await source.inspect(number)
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
        store.requestPackageRelease({ ...command, commentId: offer.commentId, before: offer.body, commentAuthor: '' })
      }
      else if (offer === undefined) {
        await source.comment(command.pullRequestNumber, `${PACKAGE_RELEASE_MARKER}\n${automatedDisclosure({ kind: 'status' })}\n\nNo matching patch or minor release is available.\n`)
      }
      store.consumePackageReleaseCommand(command)
    }
  }
  catch (error) {
    const active = store.listPackageReleases(repository.github).find(record => ['Queued', 'Prepared', 'Publishing'].includes(record.state._tag))
    if (active !== undefined && !signal.aborted) {
      const message = cleanLine(error instanceof Error ? error.message : 'The release request failed.')
      const body = `${PACKAGE_RELEASE_MARKER}\n${automatedDisclosure({ kind: 'status' })}\n\nRelease ${active.plan.version} is waiting: ${message}\nRetries keep this version.\n`
      if (active.body !== body) {
        await source.comment(active.pullRequestNumber, body, active.commentId)
        assertLease()
        store.recordPackageReleaseComment(active, body, fence, now())
      }
    }
    throw error
  }
  finally {
    store.releasePackageReleaseLease(repository.github, fence)
  }
}

function samePlan(left: PackageReleasePlan, right: PackageReleasePlan): boolean {
  return left.sourceSha === right.sourceSha && left.mergeSha === right.mergeSha
    && left.version === right.version && left.previousTag === right.previousTag
    && left.bump === right.bump && left.packageName === right.packageName
}
