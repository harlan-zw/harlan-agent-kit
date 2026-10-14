import type { RoutineDefinition } from './contract.ts'
import { err, ok } from '../result.ts'
import { candidateRoutine, candidateScanPrompt } from './candidates.ts'
import { MAXIMUM_REPORT_DETAIL_LENGTH } from './contract.ts'

const repository = 'wolfstar-project/wolfstar-agent-kit'
const allowedPath = /^(?:packages\/wolfstar-github-agent\/|wolfstar-agent-kit\/skills\/)\S+$/
const inScope = (path: string) =>
  allowedPath.test(path) && !path.split('/').some((part) => part === '..' || part === '.')

export const agentRetro: RoutineDefinition = {
  ...candidateRoutine,
  prepare: (target) =>
    target === repository
      ? ok({ _tag: 'Run', feedback: [] })
      : err(`The Agent retro Routine only runs in ${repository}.`),
  scanPrompt: (input) =>
    candidateScanPrompt(
      input,
      `Read wolfstar-agent-kit/skills/agent-retro/SKILL.md.
Follow its scheduled Routine mode and references/scheduled-routine.md.
This scan is read only. Use controller evidence supplied below.
Never read live credentials, databases, raw transcripts, or host logs.
Return a report and verdict, even when nothing needs repair.
Mark missing or sampled coverage incomplete. Never invent missing evidence.
Propose at most two proven defects inside packages/wolfstar-github-agent/ or wolfstar-agent-kit/skills/.
Read the current implementation to confirm each cause. Cite event or Incident IDs and timestamps.
Report operational blockers for their next actor. Do not propose policy, permission, merge, model, or budget changes.
Do not edit, commit, push, publish, restart, or deploy anything.`,
    ),
  parseResponse: (input) => {
    const parsed = candidateRoutine.parseResponse(input)
    if (parsed._tag === 'Err') return parsed
    if (parsed.value.report === '' || parsed.value.report.length > MAXIMUM_REPORT_DETAIL_LENGTH)
      return err('The Agent retro Routine needs a report within 20,000 characters.')
    if (parsed.value.verdict === undefined) return err('The Agent retro Routine needs a severity and coverage verdict.')
    return parsed
  },
  selectCandidates: (candidates) => candidates.filter((candidate) => inScope(candidate.target)).slice(0, 2),
  issueWork: {
    prompt: () => `This issue came from the Agent retro Routine.
Refresh its cited evidence and read the current implementation before changing it.
Reproduce the defect with a failing focused test, then fix the cause.
Change only packages/wolfstar-github-agent/ or wolfstar-agent-kit/skills/.
Preserve permissions, Review, merge rules, checks, retry bounds, and failure visibility.
Return blocked if the fix needs host changes or broader authority.
Do not commit, push, publish, restart, or deploy. The controller owns publication.`,
    verifyChanges: (_target, paths) =>
      paths.length > 0 && paths.length <= 5 && paths.every(inScope)
        ? ok(undefined)
        : err('Agent retro issue work changed files outside its allowed scope.'),
  },
}
