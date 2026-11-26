import { createHash } from 'node:crypto'

export const reservationPilotRepository = 'harlan-zw/nuxtseo.com'
export const reservationObservationIntervalMs = 2 * 60_000
const deliveryWindowMs = 45 * 60_000
const dispatchLookbackMs = 65 * 60_000

export interface ReservationRun {
  id: number
  sha: string
  startedAt: string
  updatedAt: string
  status: string | null
  conclusion: string | null
  url: string
}

export interface ReservationEvidence {
  mainSha: string
  code: ReservationRun[]
  /** A push SHA from trusted provenance, or null when the run cannot prove one. */
  deploys: { run: ReservationRun, sourceSha: string | null }[]
  activeDocsPolls: ReservationRun[]
  handoffs: { number: number, url: string }[]
  servedRevision: string | null
  mergedAt: string | null
}

export interface ReservationFinding {
  reason: string
  url?: string
}

export interface ReservationObservation {
  mode: 'Observation'
  observedAt: string
  mainSha: string | null
  beforeMerge: ReservationFinding & { verdict: 'WouldBlock' | 'WouldAllow' | 'Unknown' }
  afterMerge: ReservationFinding & { verdict: 'WouldWait' | 'WouldRelease' | 'Unknown' }
}

export function unavailableReservationObservation(at: Date): ReservationObservation {
  const unknown = { verdict: 'Unknown', reason: 'The Service could not verify the release pipeline.' } as const
  return { mode: 'Observation', observedAt: at.toISOString(), mainSha: null, beforeMerge: unknown, afterMerge: unknown }
}

function newest<T>(items: T[], id: (item: T) => number): T | undefined {
  return items.reduce<T | undefined>((latest, item) => latest === undefined || id(item) > id(latest) ? item : latest, undefined)
}

function matchesRevision(sha: string, served: string | null): boolean {
  return served === sha || served === createHash('sha256').update(sha).digest('hex')
}

function canStartDeploy(run: ReservationRun): boolean {
  return run.status === 'completed' && run.conclusion === 'success'
}

function followsCode(deploy: ReservationEvidence['deploys'][number], codeRun: ReservationRun): boolean {
  return deploy.sourceSha === codeRun.sha && deploy.run.startedAt >= codeRun.updatedAt
}

function runFinding(run: ReservationRun | undefined, reason: string): ReservationFinding | undefined {
  return run === undefined ? undefined : { reason, url: run.url }
}

export function observeMergeReservation(evidence: ReservationEvidence, at: Date): ReservationObservation {
  const { mainSha, handoffs, code, deploys } = evidence
  const mainCode = newest(code.filter(run => run.sha === mainSha), run => run.id)
  const directMainDeploy = mainCode === undefined
    ? newest(deploys.filter(deploy => deploy.sourceSha === mainSha), ({ run }) => run.id)?.run
    : undefined
  const mainDeploy = mainCode !== undefined
    ? (canStartDeploy(mainCode)
        ? newest(deploys.filter(deploy => followsCode(deploy, mainCode)), ({ run }) => run.id)?.run
        : undefined)
    : directMainDeploy
  const activeDeploy = deploys.find(({ run }) => run.status !== 'completed')?.run
  const activeCode = code.find(run => run.status !== 'completed')
  const activeWork = runFinding(activeDeploy, 'A production deploy is queued or running.')
    ?? runFinding(activeCode, 'Code on main could still start a deploy.')
    ?? runFinding(evidence.activeDocsPolls[0], 'Docs poll could still start a deploy.')
  const handoff = handoffs[0]
  // An earlier Code run can still dispatch a deploy after main's deploy starts.
  const dispatchGap = code.find(run => canStartDeploy(run)
    && Date.parse(run.updatedAt) >= at.getTime() - dispatchLookbackMs
    && !deploys.some(deploy => followsCode(deploy, run)))

  let beforeMerge: ReservationObservation['beforeMerge']
  if (handoff !== undefined) {
    beforeMerge = { verdict: 'WouldBlock', reason: `GitHub auto-merge is enabled for PR #${handoff.number}.`, url: handoff.url }
  }
  else if (activeWork !== undefined) {
    beforeMerge = { verdict: 'WouldBlock', ...activeWork }
  }
  else if (mainCode !== undefined && mainCode.conclusion !== 'success') {
    beforeMerge = { verdict: 'WouldBlock', reason: 'Code has no passing result for this main commit.', url: mainCode.url }
  }
  else if (mainDeploy === undefined) {
    beforeMerge = mainCode === undefined
      ? { verdict: 'Unknown', reason: 'GitHub has no Code or production deploy run for this main commit.' }
      : { verdict: 'WouldBlock', reason: 'Code passed. GitHub has yet to show its production deploy.', url: (dispatchGap ?? mainCode).url }
  }
  else if (dispatchGap !== undefined) {
    beforeMerge = { verdict: 'WouldBlock', reason: 'Code passed. GitHub has yet to show its production deploy.', url: dispatchGap.url }
  }
  else if (mainDeploy.conclusion === null) {
    beforeMerge = { verdict: 'Unknown', reason: 'GitHub has yet to report the production deploy result.', url: mainDeploy.url }
  }
  else {
    beforeMerge = { verdict: 'WouldAllow', reason: 'The observed deploy pipeline has settled.', url: mainDeploy.url }
  }

  let afterMerge: ReservationObservation['afterMerge']
  if (mainDeploy?.status === 'completed' && mainDeploy.conclusion === 'success'
    && activeWork === undefined && dispatchGap === undefined
    && matchesRevision(mainSha, evidence.servedRevision)) {
    afterMerge = { verdict: 'WouldRelease', reason: 'Production serves the exact main commit.', url: mainDeploy.url }
  }
  else if (mainCode?.status === 'completed' && mainCode.conclusion !== null && mainCode.conclusion !== 'success') {
    afterMerge = { verdict: 'WouldRelease', reason: `Code concluded ${mainCode.conclusion}.`, url: mainCode.url }
  }
  else if (mainDeploy?.status === 'completed' && mainDeploy.conclusion !== null && mainDeploy.conclusion !== 'success') {
    afterMerge = { verdict: 'WouldRelease', reason: `The production deploy concluded ${mainDeploy.conclusion}.`, url: mainDeploy.url }
  }
  else if (evidence.mergedAt !== null && at.getTime() >= Date.parse(evidence.mergedAt) + deliveryWindowMs) {
    afterMerge = { verdict: 'WouldRelease', reason: 'The 45-minute delivery window expired.' }
  }
  else if (activeWork !== undefined) {
    afterMerge = { verdict: 'WouldWait', ...activeWork }
  }
  else if (dispatchGap !== undefined) {
    afterMerge = { verdict: 'WouldWait', reason: 'A successful Code run could still start a deploy.', url: dispatchGap.url }
  }
  else if (mainDeploy !== undefined) {
    afterMerge = { verdict: 'WouldWait', reason: 'Waiting for the deploy and the production revision.', url: mainDeploy.url }
  }
  else if (mainCode !== undefined) {
    afterMerge = { verdict: 'WouldWait', reason: 'Waiting for the production deploy for this commit.', url: mainCode.url }
  }
  else {
    afterMerge = { verdict: 'Unknown', reason: 'Delivery evidence for this main commit is missing.' }
  }
  return { mode: 'Observation', observedAt: at.toISOString(), mainSha, beforeMerge, afterMerge }
}
