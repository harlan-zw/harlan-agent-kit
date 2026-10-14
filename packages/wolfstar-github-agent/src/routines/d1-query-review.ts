import type { RoutineDefinition } from './contract.ts'
import { PRODUCTION_D1_REPOSITORIES } from '../d1-query-scope.ts'
import { err, ok } from '../result.ts'
import { candidateRoutine, candidateScanPrompt } from './candidates.ts'
import { MAXIMUM_REPORT_DETAIL_LENGTH } from './contract.ts'

/** Reviews production bindings, including tenant databases provisioned at runtime. */
export const d1QueryReview: RoutineDefinition = {
  ...candidateRoutine,
  prepare: (repository) =>
    PRODUCTION_D1_REPOSITORIES.has(repository)
      ? ok({ _tag: 'Run', feedback: [] })
      : err('D1 query review requires an approved production site.'),
  schema: {
    ...candidateRoutine.schema,
    properties: {
      ...candidateRoutine.schema.properties,
      report: { type: 'string', maxLength: MAXIMUM_REPORT_DETAIL_LENGTH },
    },
  },
  scanPrompt: (input) =>
    candidateScanPrompt(
      input,
      `Read the installed wolfstar-agent-kit:d1-query-review Skill before collection.
Review every production D1 database used by this site. Include runtime-created tenant databases and shared bindings.
Use controller-injected collection credentials. Preserve DAILY_CHECKIN_DIR for the durable private archive.
Keep GitHub, repository files, deployment state, and databases read only.
Return the ranked report and an explicit verdict. Missing inventory or query evidence means incomplete coverage.
Only evidence-backed repository repairs become Candidates. Archive maintenance never becomes a Candidate.`,
    ),
  parseResponse: (input) => {
    const result = candidateRoutine.parseResponse(input)
    if (result._tag === 'Err') return result
    if (result.value.report === '' || result.value.report.length > MAXIMUM_REPORT_DETAIL_LENGTH)
      return err(`D1 review needs a report within ${MAXIMUM_REPORT_DETAIL_LENGTH} characters.`)
    if (result.value.verdict === undefined) return err('D1 review needs a severity and coverage verdict.')
    return result
  },
  issueWork: {
    ...candidateRoutine.issueWork,
    prompt: (
      target,
    ) => `Read the installed wolfstar-agent-kit:d1-query-review Skill. Reproduce the proven cause at ${target} using local fixtures.
Use a failing regression test before changing query code or a migration. Verify query results and query plans.
Keep production read only. Never apply migrations, commit, push, or publish. The controller owns publication.`,
  },
}
