import type { RoutineDefinition } from './contract.ts'
import { err } from '../result.ts'
import { candidateRoutine, candidateScanPrompt } from './candidates.ts'

const DAILY_CHECKIN_TURN = `Apply the harlan-agent-kit:daily-checkin skill. Read it before you start.

Use this repository's nuxt-checkin module configuration and its prompt items. No site-local daily-checkin skill is required.
This worktree is disposable. Preserve DAILY_CHECKIN_DIR and keep evidence, reports, and the ledger there.
Keep production access read only. Do not commit or push anything.
Write the published report into \`report\`. Keep the exhaustive record in the archive, not in \`report\`.
State the run's conclusion in \`verdict\`. Set \`severity\` to GREEN, AMBER, or RED, and \`coverage\` to complete or incomplete.
The verdict decides the issue title, so state it as a field. Never leave it to the report prose.
Return only code or repository changes as Candidates. Keep production operations and human decisions in the report.
Use each action's stable ledger fingerprint. Put its title in \`title\`, action in \`claim\`, target in \`target\`, and proving check in \`verification\`.`

export const dailyCheckin: RoutineDefinition = {
  ...candidateRoutine,
  parseResponse: (input) => {
    const parsed = candidateRoutine.parseResponse(input)
    if (parsed._tag === 'Err')
      return parsed
    if (parsed.value.report === '')
      return err('The daily check-in Routine answered without its report.')
    // The issue title is the only status most mornings get read at. A run that
    // states no verdict cannot title its own issue, so it is a failed answer,
    // not a BLOCKED morning.
    if (parsed.value.verdict === undefined)
      return err('The daily check-in Routine answered without its verdict.')
    return parsed
  },
  scanPrompt: input => candidateScanPrompt(input, DAILY_CHECKIN_TURN),
}
