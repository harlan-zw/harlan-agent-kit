import type { RoutineDefinition } from './contract.ts'
import { err } from '../result.ts'
import { candidateRoutine, candidateScanPrompt } from './candidates.ts'

const DAILY_CHECKIN_TURN = `Apply the daily-checkin skill at .claude/skills/daily-checkin/SKILL.md in this repository. Read it before you start.

Follow its workflow completely, including running its data script and writing its report and ledger files. This worktree is disposable. Keep evidence and reports in the supplied DAILY_CHECKIN_DIR, outside the worktree. Copy the whole Markdown report, from the verdict line through the proposed actions, into \`report\`. Do not commit or push anything. Keep production access read only.

The controller supplies DAILY_CHECKIN_DIR for this repository. Preserve it when loading credentials.
Configure the collector to use that directory. If it ignores the directory, report incomplete persistence and propose its configuration fix.
Read prior evidence there. On the first run, consult the previous durable archive or tracked archive, without overwriting newer evidence.
A stale baseline does not prove the scheduler skipped runs. Report its age and the evidence source.

Capture the collector exit code before formatting output. Never read $? after piping through tail, head, tee, or sed.
Use a log file: run the collector with output redirected, save its exit code immediately, then read the file.
Read coverage, severity, and every unavailable result. Report incomplete coverage even when no new Candidate exists.
A completed Agent turn does not establish healthy production. Keep the collector exit code and coverage in the report.

Read expected deployment IDs independently from Cloudflare deployment metadata or a successful deploy job with its actual steps.
Never copy the expected deployment from the report endpoint under test or assume local HEAD was deployed.
If independent deployment evidence is unavailable, report incomplete coverage. Never manufacture a passing identity check.

Return only code or repository changes as Candidates. Keep release tags, credential changes, production operations, customer replies, and human decisions in the report. Name their next actor and existing issue. Do not invent a file edit to represent them. Use the ledger fingerprint as the Candidate fingerprint when the action has one. Put a short issue title in \`title\`, the action in \`claim\`, the file or system it changes in \`target\`, and the check that proves it in \`verification\`.`

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
