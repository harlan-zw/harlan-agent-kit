import type { RoutineDefinition } from './contract.ts'
import { err } from '../result.ts'
import { candidateRoutine, candidateScanPrompt } from './candidates.ts'

const DAILY_CHECKIN_TURN = `Apply the harlan-agent-kit:daily-checkin skill. Read it before you start.

Use this repository's nuxt-checkin module configuration and its prompt items. No site-local daily-checkin skill is required.
This worktree is disposable. Preserve DAILY_CHECKIN_DIR and keep evidence, reports, and the ledger there.
Keep production access read only. Do not commit or push anything.
Copy the full Markdown report into \`report\`, including collector exit code, coverage, and every prompt item's findings.
Return only code or repository changes as Candidates. Keep production operations and human decisions in the report.
Use each action's stable ledger fingerprint. Put its title in \`title\`, action in \`claim\`, target in \`target\`, and proving check in \`verification\`.`

export const dailyCheckin: RoutineDefinition = {
  ...candidateRoutine,
  parseResponse: (input) => {
    const parsed = candidateRoutine.parseResponse(input)
    if (parsed._tag === 'Err')
      return parsed
    return parsed.value.report === '' ? err('The daily check-in Routine answered without its report.') : parsed
  },
  scanPrompt: input => candidateScanPrompt(input, DAILY_CHECKIN_TURN),
}
