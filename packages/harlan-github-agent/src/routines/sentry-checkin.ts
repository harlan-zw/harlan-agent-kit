import type { RoutineDefinition, RoutineScanInput } from './contract.ts'
import { err } from '../result.ts'
import { candidateRoutine, candidateScanPrompt } from './candidates.ts'

function sentryCheckinTurn(mode: RoutineScanInput['mode']): string {
  return `Apply the harlan-agent-kit:sentry-checkin skill and its references/scheduled-routine.md contract. Read both before you start.

This is a scheduled Routine for the named repository and the controller's prepared worktree only.
Do not edit repository files, commit, push, open pull requests, deploy, or delegate another site Agent.
Persist the audited ledger and record the run history, even with zero code proposals.
Return the complete issue report in \`report\`, including issue counts, resolution results, and artifact paths.
Return only code repairs as Candidates. Sentry resolutions do not require code proposals.

${mode === 'propose'
  ? 'Resolve eligible issues in their verified deployed release during this run. Run the resolution plan before --apply, then verify each issue status.'
  : 'Keep Sentry read only. Do not resolve issues or run resolve with --apply. Report eligible resolutions for a propose run.'}`
}

export const sentryCheckin: RoutineDefinition = {
  ...candidateRoutine,
  scanPrompt: input => candidateScanPrompt(input, sentryCheckinTurn(input.mode)),
  parseResponse: (input) => {
    const parsed = candidateRoutine.parseResponse(input)
    if (parsed._tag === 'Err')
      return parsed
    return parsed.value.report === '' ? err('The Sentry Routine answered without its issue report.') : parsed
  },
  findingsLabel: 'code proposals',
}
