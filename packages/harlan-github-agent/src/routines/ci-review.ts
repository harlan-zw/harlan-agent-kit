import type { RoutineDefinition } from './contract.ts'
import { err } from '../result.ts'
import { candidateRoutine, candidateScanPrompt } from './candidates.ts'
import { MAXIMUM_REPORT_DETAIL_LENGTH } from './contract.ts'

export const ciReview: RoutineDefinition = {
  ...candidateRoutine,
  schema: {
    ...candidateRoutine.schema,
    required: ['report', 'candidates'],
    properties: {
      ...candidateRoutine.schema.properties,
      report: { ...candidateRoutine.schema.properties.report, maxLength: MAXIMUM_REPORT_DETAIL_LENGTH },
    },
  },
  scanPrompt: input => candidateScanPrompt(input, `Read the installed harlan-agent-kit:ci-review Skill. Follow scan mode for this repository only.
Inspect recent GitHub Actions logs, including successful runs, and triage warnings and errors using their surrounding context.
Return a Markdown report within ${MAXIMUM_REPORT_DETAIL_LENGTH} characters, even with no Candidates or unavailable logs.
If all diagnostic dispositions cannot fit, mark coverage incomplete and state the omitted scope.
Keep repository files and GitHub read only. Return actionable repository repairs as Candidates for existing Issue triage.
Do not duplicate Baseline repair or work already owned by an open issue or pull request.`),
  parseResponse: (input) => {
    const parsed = candidateRoutine.parseResponse(input)
    if (parsed._tag === 'Err')
      return parsed
    if (parsed.value.report.length > MAXIMUM_REPORT_DETAIL_LENGTH)
      return err(`The CI review report exceeds ${MAXIMUM_REPORT_DETAIL_LENGTH} characters. Shorten it and mark coverage incomplete if diagnostic dispositions cannot fit.`)
    return parsed.value.report === '' ? err('The CI review Routine answered without its report.') : parsed
  },
  issueWork: {
    ...candidateRoutine.issueWork,
    prompt: () => 'Read the installed harlan-agent-kit:ci-review Skill. Follow implementation mode within this prepared worktree. Refresh the cited CI evidence, reproduce the finding, and fix its cause. Preserve check coverage and failure visibility. Do not commit, push, publish, or change GitHub settings. The controller owns publication.',
  },
}
