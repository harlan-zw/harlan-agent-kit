import type { RoutineDefinition } from './contract.ts'
import { candidateRoutine, candidateScanPrompt } from './candidates.ts'

const DAILY_CHECKIN_TURN = `Apply the daily-checkin skill at .claude/skills/daily-checkin/SKILL.md in this repository. Read it before you start.

Follow its workflow completely, including running its data script and writing its report and ledger files. This worktree is disposable and nothing in it is kept, so copy the whole Markdown report, from the verdict line through the proposed actions, into \`report\`. Do not commit or push anything. Keep production access read only.

Return only code or repository changes as Candidates. Keep release tags, credential changes, production operations, customer replies, and human decisions in the report. Name their next actor and existing issue. Do not invent a file edit to represent them. Use the ledger fingerprint as the Candidate fingerprint when the action has one. Put a short issue title in \`title\`, the action in \`claim\`, the file or system it changes in \`target\`, and the check that proves it in \`verification\`.`

export const dailyCheckin: RoutineDefinition = {
  ...candidateRoutine,
  scanPrompt: input => candidateScanPrompt(input, DAILY_CHECKIN_TURN),
}
