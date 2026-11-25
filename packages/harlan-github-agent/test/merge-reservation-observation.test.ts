import type { ReservationEvidence, ReservationRun } from '../src/merge-reservation-observation.ts'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { observeMergeReservation, unavailableReservationObservation } from '../src/merge-reservation-observation.ts'
import { openJournalStore } from '../src/store.ts'

const sha = 'a'.repeat(40)
const older = 'b'.repeat(40)
const merge = '2026-11-25T01:00:00Z'
const now = new Date('2026-11-25T01:25:00Z')
const codeUrl = 'https://github.com/run/1'
const deployUrl = 'https://github.com/run/2'
const code: ReservationRun = { id: 1, sha, url: codeUrl, startedAt: merge, updatedAt: '2026-11-25T01:04:00Z', status: 'completed', conclusion: 'success' }
const deploy: ReservationRun = { ...code, id: 2, url: deployUrl, startedAt: '2026-11-25T01:05:00Z', updatedAt: '2026-11-25T01:20:00Z' }
const digest = createHash('sha256').update(sha).digest('hex')

function evidence(overrides: Partial<ReservationEvidence> = {}): ReservationEvidence {
  return { mainSha: sha, code: [code], deploys: [{ run: deploy, sourceSha: sha }], handoffs: [], servedRevision: digest, mergedAt: merge, ...overrides }
}

it('blocks when main Code passes before GitHub shows a matching deploy', () => {
  const result = observeMergeReservation(evidence({ deploys: [] }), now)
  expect(result.beforeMerge).toMatchObject({ verdict: 'WouldBlock', url: codeUrl })
  expect(result.afterMerge.verdict).toBe('WouldWait')
})

it('does not treat a skipped upstream trigger as an idle pipeline', () => {
  const result = observeMergeReservation(evidence({ code: [], deploys: [] }), now)
  expect(result.beforeMerge.verdict).toBe('Unknown')
  expect(result.afterMerge.verdict).toBe('Unknown')
})

it('blocks an enabled GitHub Auto merge handoff even when the deploy settled', () => {
  const url = 'https://github.com/harlan-zw/nuxtseo.com/pull/40'
  const result = observeMergeReservation(evidence({ handoffs: [{ number: 40, url }] }), now)
  expect(result.beforeMerge).toMatchObject({ verdict: 'WouldBlock', url })
  expect(result.afterMerge.verdict).toBe('WouldRelease')
})

it('blocks on a queued standalone deploy without using it as revision evidence', () => {
  const manual = { ...deploy, id: 3, status: 'queued', conclusion: null }
  const result = observeMergeReservation(evidence({ deploys: [{ run: manual, sourceSha: null }] }), now)
  expect(result.beforeMerge).toMatchObject({ verdict: 'WouldBlock', url: manual.url })
  expect(result.afterMerge.verdict).toBe('WouldWait')
})

it('detects an earlier push that can still trigger an overlapping deploy', () => {
  const prior = { ...code, id: 3, sha: older, updatedAt: '2026-11-25T01:08:00Z', url: 'https://github.com/run/3' }
  const result = observeMergeReservation(evidence({ code: [code, prior] }), now)
  expect(result.beforeMerge).toMatchObject({ verdict: 'WouldBlock', url: prior.url })
  expect(result.afterMerge.verdict).toBe('WouldWait')
})

it('would release when the matching workflow passes and production serves its SHA digest', () => {
  const result = observeMergeReservation(evidence(), now)
  expect(result.beforeMerge).toMatchObject({ verdict: 'WouldAllow', url: deployUrl })
  expect(result.afterMerge).toMatchObject({ verdict: 'WouldRelease', url: deployUrl, reason: 'Production serves the exact main commit.' })
})

it('waits when the passing workflow and live revision disagree', () => {
  const result = observeMergeReservation(evidence({ servedRevision: older }), now)
  expect(result.afterMerge.verdict).toBe('WouldWait')
})

it('reports release on cancellation with a link to the affected deployment', () => {
  const cancelled = { ...deploy, conclusion: 'cancelled' }
  const result = observeMergeReservation(evidence({ deploys: [{ run: cancelled, sourceSha: sha }] }), now)
  expect(result.afterMerge).toEqual({ verdict: 'WouldRelease', reason: 'The production deploy concluded cancelled.', url: deployUrl })
})

it('expires delivery only when GitHub confirmed the merge time', () => {
  const deadline = new Date('2026-11-25T01:45:00Z')
  expect(observeMergeReservation(evidence({ servedRevision: null }), deadline).afterMerge)
    .toEqual({ verdict: 'WouldRelease', reason: 'The 45-minute delivery window expired.' })
  expect(observeMergeReservation(evidence({ mergedAt: null, servedRevision: null }), deadline).afterMerge.verdict)
    .toBe('WouldWait')
})

it('keeps changes across restarts and refreshes unchanged observations in place', () => {
  const path = mkdtempSync(join(tmpdir(), 'reservation-observations-'))
  const database = join(path, 'journal.sqlite')
  const verified = observeMergeReservation(evidence(), now)
  const refreshed = { ...verified, observedAt: '2026-11-25T01:27:00.000Z' }
  const unknown = unavailableReservationObservation(new Date('2026-11-25T01:29:00Z'))
  try {
    const first = openJournalStore(database, false)
    first.recordReservationObservation(verified)
    first.recordReservationObservation(refreshed)
    first.close()
    const reopened = openJournalStore(database, false)
    try {
      reopened.recordReservationObservation(unknown)
      expect(reopened.listReservationObservations()).toEqual([unknown, refreshed])
    }
    finally {
      reopened.close()
    }
  }
  finally {
    rmSync(path, { recursive: true, force: true })
  }
})
