import type { RoutineDefinition } from './contract.ts'
import { err } from '../result.ts'
import { candidateRoutine, candidateScanPrompt } from './candidates.ts'
import { MAXIMUM_REPORT_DETAIL_LENGTH } from './contract.ts'

export const seoReview: RoutineDefinition = {
  ...candidateRoutine,
  schema: {
    ...candidateRoutine.schema,
    required: ['report', 'candidates'],
    properties: {
      ...candidateRoutine.schema.properties,
      report: { ...candidateRoutine.schema.properties.report, maxLength: MAXIMUM_REPORT_DETAIL_LENGTH },
    },
  },
  scanPrompt: input => candidateScanPrompt(input, `Read the installed harlan-agent-kit:seo-review Skill. Follow scan mode for this repository only.
Match this repository to one NuxtSEO Site through tracked configuration, then read its ranked actions with the nuxtseo CLI.
Return a Markdown report within ${MAXIMUM_REPORT_DETAIL_LENGTH} characters, even when the Site cannot be matched or a read fails.
Name every action you judged, its disposition, and every action you did not judge.
Return one Candidate for each repository fix the current default branch still needs.
Keep repository files and GitHub read only. Never resolve, dismiss, scan, annotate, or run live research in NuxtSEO.
Do not duplicate work already owned by an open issue or pull request.`),
  parseResponse: (input) => {
    const parsed = candidateRoutine.parseResponse(input)
    if (parsed._tag === 'Err')
      return parsed
    if (parsed.value.report.length > MAXIMUM_REPORT_DETAIL_LENGTH)
      return err(`The SEO review report exceeds ${MAXIMUM_REPORT_DETAIL_LENGTH} characters. Shorten it and name the actions it omits.`)
    return parsed.value.report === '' ? err('The SEO review Routine answered without its report.') : parsed
  },
  issueWork: {
    ...candidateRoutine.issueWork,
    prompt: target => `Read the installed harlan-agent-kit:seo-review Skill. Follow implementation mode within this prepared worktree for ${target}.
Re-read the cited NuxtSEO actions, reproduce the defect against the current code, and fix its cause.
Do not resolve or dismiss the actions, and do not start a page scan. Name the action IDs to resolve after deploy in the pull request body.
Do not commit, push, publish, or change GitHub settings. The controller owns publication.`,
  },
}
