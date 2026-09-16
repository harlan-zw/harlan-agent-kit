import type { Result } from '../result.ts'
import type { AgentFeedbackSignal, Candidate, RoutineMode, RoutineName } from '../types.ts'

export type RoutineCandidate = Pick<Candidate, 'fingerprint' | 'title' | 'target' | 'claim' | 'verification' | 'estimatedChangedFiles'>

/**
 * What a check-in run concluded, in fields rather than prose.
 *
 * The status a reader sees on the issue title used to be scraped out of the
 * report's first line. Prose does not survive that: a report that opens with a
 * Markdown heading carries no verdict on line one, and a verdict that ends "no
 * incomplete coverage" reads as incomplete to a keyword scan. Both shipped, and
 * every title read BLOCKED. The run states its own verdict instead.
 *
 * Severity and coverage travel together because neither alone decides the
 * status: incomplete coverage blocks a GREEN run.
 */
export interface CheckinVerdict {
  severity: 'GREEN' | 'AMBER' | 'RED'
  coverage: 'complete' | 'incomplete'
}

export interface RoutineScanResponse {
  report: string
  candidates: RoutineCandidate[]
  verdict?: CheckinVerdict
}

export interface RoutineScanInput {
  name: RoutineName
  repository: string
  mode: RoutineMode
  priorCandidates: readonly Candidate[]
  feedback?: readonly AgentFeedbackSignal[]
}

export type RoutinePreparation
  = | { _tag: 'Run', feedback: readonly AgentFeedbackSignal[] }
    | { _tag: 'Skip', evidence: string, progressLabel: string }

/** Built-in policy only. Repository YAML cannot supply implementations. */
export interface RoutineDefinition {
  schema: Record<string, unknown>
  prepare: (repository: string, evidence: { listAgentFeedback: (limit: number) => AgentFeedbackSignal[] }) => Result<RoutinePreparation, string>
  scanPrompt: (input: RoutineScanInput) => string
  parseResponse: (input: unknown) => Result<RoutineScanResponse, string>
  selectCandidates: (candidates: readonly RoutineCandidate[]) => RoutineCandidate[]
  maximumChangedFiles: number | null
  findingsLabel: string
  issueFingerprint: (candidateFingerprint: string) => string
  issueWork: {
    prompt: (target: string) => string
    verifyChanges: (target: string, changedPaths: readonly string[]) => Result<void, string>
  }
}
export const MAXIMUM_REPORT_DETAIL_LENGTH = 20_000
