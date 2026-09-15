import type { RoutineDefinition } from './contract.ts'
import { err } from '../result.ts'
import { candidateRoutine, candidateScanPrompt } from './candidates.ts'

export const ciReview: RoutineDefinition = {
  ...candidateRoutine,
  schema: { ...candidateRoutine.schema, required: ['report', 'candidates'] },
  scanPrompt: input => candidateScanPrompt(input, `Read the installed harlan-agent-kit:ci-review Skill. Follow scan mode for this repository only.
Inspect recent GitHub Actions logs, including successful runs, and triage warnings and errors using their surrounding context.
Return a complete Markdown report in report, even with no Candidates or unavailable logs.
Keep repository files and GitHub read only. Return actionable repository repairs as Candidates for existing Issue triage.
Do not duplicate Baseline repair or work already owned by an open issue or pull request.`),
  parseResponse: (input) => {
    const parsed = candidateRoutine.parseResponse(input)
    if (parsed._tag === 'Err')
      return parsed
    return parsed.value.report === '' ? err('The CI review Routine answered without its report.') : parsed
  },
  issueWork: {
    ...candidateRoutine.issueWork,
    prompt: () => 'Read the installed harlan-agent-kit:ci-review Skill. Follow implementation mode within this prepared worktree. Refresh the cited CI evidence, reproduce the finding, and fix its cause. Preserve check coverage and failure visibility. Do not commit, push, publish, or change GitHub settings. The controller owns publication.',
  },
}
