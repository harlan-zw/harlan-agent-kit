import type { Result } from '../result.ts'
import type { AgentFeedbackSignal, Candidate, RoutineMode, RoutineName } from '../types.ts'

export type RoutineCandidate = Pick<Candidate, 'fingerprint' | 'title' | 'target' | 'claim' | 'verification' | 'estimatedChangedFiles'>

export interface RoutineScanResponse {
  report: string
  candidates: RoutineCandidate[]
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
