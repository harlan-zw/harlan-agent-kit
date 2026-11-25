import { createHash } from 'node:crypto'

export const reservationPilotRepository = 'harlan-zw/nuxtseo.com'
export const reservationObservationIntervalMs = 2 * 60_000
const deliveryWindowMs = 45 * 60_000

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

export function observeMergeReservation(evidence: ReservationEvidence, at: Date): ReservationObservation {
  const { mainSha, handoffs, code, deploys } = evidence
  const mainCode = newest(code.filter(run => run.sha === mainSha), run => run.id)
  const mainDeploy = newest(deploys.filter(({ sourceSha }) => sourceSha === mainSha), ({ run }) => run.id)?.run
  const activeDeploy = deploys.find(({ run }) => run.status !== 'completed')?.run
  const activeCode = code.find(run => run.status !== 'completed')
  const handoff = handoffs[0]
  // A rerun of an earlier Code workflow can finish after the current deploy
  // starts and still be about to dispatch another deploy.
  const dispatchGap = mainDeploy === undefined
    ? undefined
    : code.find(run => run.status === 'completed' && run.conclusion === 'success'
      && run.updatedAt > mainDeploy.startedAt
      && !deploys.some(deploy => deploy.sourceSha === run.sha && deploy.run.startedAt >= run.updatedAt))

  let beforeMerge: ReservationObservation['beforeMerge']
  if (handoff !== undefined) {
    beforeMerge = { verdict: 'WouldBlock', reason: `GitHub auto-merge is enabled for PR #${handoff.number}.`, url: handoff.url }
  }
  else if (activeDeploy !== undefined) {
    beforeMerge = { verdict: 'WouldBlock', reason: 'A production deploy is queued or running.', url: activeDeploy.url }
  }
  else if (activeCode !== undefined) {
    beforeMerge = { verdict: 'WouldBlock', reason: 'Code on main could still start a deploy.', url: activeCode.url }
  }
  else if (mainCode === undefined) {
    beforeMerge = { verdict: 'Unknown', reason: 'GitHub has no Code run for this main commit.' }
  }
  else if (mainCode.conclusion !== 'success') {
    beforeMerge = { verdict: 'WouldBlock', reason: 'Code has no passing result for this main commit.', url: mainCode.url }
  }
  else if (mainDeploy === undefined || dispatchGap !== undefined) {
    beforeMerge = { verdict: 'WouldBlock', reason: 'Code passed. GitHub has yet to show its production deploy.', url: (dispatchGap ?? mainCode).url }
  }
  else if (mainDeploy.conclusion === null) {
    beforeMerge = { verdict: 'Unknown', reason: 'GitHub has yet to report the production deploy result.', url: mainDeploy.url }
  }
  else {
    beforeMerge = { verdict: 'WouldAllow', reason: 'The observed deploy pipeline has settled.', url: mainDeploy.url }
  }

  let afterMerge: ReservationObservation['afterMerge']
  if (mainCode?.status === 'completed' && mainCode.conclusion === 'success'
    && mainDeploy?.status === 'completed' && mainDeploy.conclusion === 'success'
    && dispatchGap === undefined && matchesRevision(mainSha, evidence.servedRevision)) {
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
