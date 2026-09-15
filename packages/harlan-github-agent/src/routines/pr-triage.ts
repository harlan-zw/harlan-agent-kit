import type { RoutineDefinition } from './contract.ts'
import { candidateRoutine, candidateScanPrompt } from './candidates.ts'

export const prTriage: RoutineDefinition = {
  ...candidateRoutine,
  scanPrompt: input => candidateScanPrompt(input, `Apply the harlan-agent-kit:pr-triage skill. Read it before you start.

This turn is read only. The worktree is the default branch. Do not edit, commit,
or push anything. Report what you find and stop.`),
}
