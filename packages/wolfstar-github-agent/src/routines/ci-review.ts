import type { RoutineDefinition } from './contract.ts'
import { createHash } from 'node:crypto'
import { err, ok } from '../result.ts'
import { candidateRoutine, candidateScanPrompt } from './candidates.ts'
import { MAXIMUM_REPORT_DETAIL_LENGTH } from './contract.ts'

export const ciReview: RoutineDefinition = {
  ...candidateRoutine,
  schema: {
    ...candidateRoutine.schema,
    properties: {
      ...candidateRoutine.schema.properties,
      report: { ...candidateRoutine.schema.properties.report, maxLength: MAXIMUM_REPORT_DETAIL_LENGTH },
      candidates: {
        ...candidateRoutine.schema.properties.candidates,
        items: {
          ...candidateRoutine.schema.properties.candidates.items,
          required: [...candidateRoutine.schema.properties.candidates.items.required, 'urgency'],
          properties: {
            ...candidateRoutine.schema.properties.candidates.items.properties,
            urgency: { type: 'string', enum: ['urgent', 'maintenance'] },
          },
        },
      },
    },
  },
  scanPrompt: (input) =>
    candidateScanPrompt(
      input,
      `Read the installed wolfstar-agent-kit:ci-review Skill. Follow scan mode for this repository only.
Inspect recent GitHub Actions logs, including successful runs, and triage warnings and errors using their surrounding context.
Return a Markdown report within ${MAXIMUM_REPORT_DETAIL_LENGTH} characters, even with no Candidates or unavailable logs.
If all diagnostic dispositions cannot fit, mark coverage incomplete and state the omitted scope.
Keep repository files and GitHub read only. Return actionable repository repairs as Candidates for existing Issue triage.
Set each Candidate's urgency to urgent for broken checks, security defects, or user impact.
Use maintenance for successful-run warnings, deprecations, and cleanup. The controller combines maintenance before opening issues.
Do not duplicate Baseline repair or work already owned by an open issue or pull request.`,
    ),
  parseResponse: (input) => {
    const parsed = candidateRoutine.parseResponse(input)
    if (parsed._tag === 'Err') return parsed
    if (parsed.value.report.length > MAXIMUM_REPORT_DETAIL_LENGTH)
      return err(
        `The CI review report exceeds ${MAXIMUM_REPORT_DETAIL_LENGTH} characters. Shorten it and mark coverage incomplete if diagnostic dispositions cannot fit.`,
      )
    if (parsed.value.report === '') return err('The CI review Routine answered without its report.')
    const raw = (input as { candidates: Array<{ urgency?: unknown }> }).candidates
    if (raw.some((candidate) => candidate.urgency !== 'urgent' && candidate.urgency !== 'maintenance'))
      return err('Each CI Candidate needs urgency: urgent or maintenance.')
    const urgent = parsed.value.candidates.filter((_, index) => raw[index]?.urgency === 'urgent')
    const maintenance = parsed.value.candidates
      .filter((_, index) => raw[index]?.urgency === 'maintenance')
      .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint))
    const groups: (typeof maintenance)[] = []
    for (const candidate of maintenance) {
      const group = groups.at(-1)
      if (
        group === undefined ||
        group.reduce((total, entry) => total + entry.estimatedChangedFiles, 0) + candidate.estimatedChangedFiles > 5
      )
        groups.push([candidate])
      else group.push(candidate)
    }
    return ok({
      ...parsed.value,
      candidates: [
        ...urgent,
        ...groups.map((group) =>
          group.length === 1
            ? group[0]!
            : {
                fingerprint: `ci-maintenance#${createHash('sha256')
                  .update(group.map((candidate) => candidate.fingerprint).join('\n'))
                  .digest('hex')
                  .slice(0, 16)}`,
                title: 'Resolve CI maintenance findings',
                target: group.map((candidate) => candidate.target).join(', '),
                claim: group.map((candidate) => `${candidate.fingerprint}: ${candidate.claim}`).join('\n\n'),
                verification: [...new Set(group.map((candidate) => candidate.verification))].join(' && '),
                estimatedChangedFiles: group.reduce((total, candidate) => total + candidate.estimatedChangedFiles, 0),
              },
        ),
      ],
    })
  },
  issueWork: {
    ...candidateRoutine.issueWork,
    prompt: () =>
      'Read the installed wolfstar-agent-kit:ci-review Skill. Follow implementation mode within this prepared worktree. Refresh the cited CI evidence, reproduce the finding, and fix its cause. Preserve check coverage and failure visibility. Do not commit, push, publish, or change GitHub settings. The controller owns publication.',
  },
}
