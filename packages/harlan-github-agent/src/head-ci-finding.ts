/**
 * The Review finding one red head check becomes.
 *
 * A Review Agent that reads a failing head check records it as one material
 * finding and hands it to Repair. CI that turns red after the Review settles
 * reaches no agent, so on 2026-09-22 nuxt/scripts#926 published BLOCKED and
 * queued nothing: a stale end-to-end assertion, one line, sat there until
 * Harlan found it. The controller now writes the same finding the Review Agent
 * would have written, so the existing Repair path carries it.
 *
 * This module decides only what the finding says. It reads no store and no
 * GitHub, so the sweep owns every side effect.
 */
import type { ReviewFinding } from './types.ts'

/** The stable identity of one red check, so repeated passes record it once. */
export function headCiFingerprint(check: string): string {
  return `head-check-failed:${check.toLocaleLowerCase('en-US')}`
}

/**
 * Writes the finding for one required check that fails on the head commit.
 *
 * The location names the workflow directory rather than a source file, because
 * only the job logs say which file is at fault, and the Repair Agent reads
 * those. Naming a guessed file would send it to the wrong place.
 */
export function headCiFinding(check: string): Extract<ReviewFinding, { _tag: 'Open' }> {
  return {
    _tag: 'Open',
    summary: `Required check "${check}" fails on the pull request head commit.`,
    nextAction: `Read the failing "${check}" job logs on the pull request, fix the cause, and run only the focused check.`,
    resolution: 'Repair',
    details: {
      fingerprint: headCiFingerprint(check),
      identity: check,
      location: { path: '.github/workflows', line: null },
      proof: `GitHub reports check run "${check}" as failed on the head commit, and the same check does not fail on the base commit.`,
      regressionTest: null,
    },
  }
}

/** True when this Review already carries the finding for the same red check. */
export function hasHeadCiFinding(findings: readonly ReviewFinding[], check: string): boolean {
  const fingerprint = headCiFingerprint(check)
  return findings.some(finding => finding._tag === 'Open' && finding.details?.fingerprint === fingerprint)
}
