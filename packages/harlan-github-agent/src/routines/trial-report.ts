import type { RoutineDefinition } from './contract.ts'
import { err, ok } from '../result.ts'
import { candidateRoutine } from './candidates.ts'
import { MAXIMUM_REPORT_DETAIL_LENGTH } from './contract.ts'

const repository = 'harlan-zw/harlan-agent-kit'

const TRIAL_REPORT_TURN = `Write this week's trial report from the controller Service evidence below. Use that evidence only.
Do not read the repository, run commands, or open live databases, credentials, transcripts, or host logs.
This Routine proposes no change and requests no issue. Return an empty candidates list and a null verdict.

Write \`report\` as short Markdown, one section per trial, in evidence order.
For each trial, copy its \`markdown\` lines unchanged. Never recompute, round, or reword a number.
A rule marked "needs Harlan" is Harlan's call. Never call it met.
If the evidence contradicts a suggested verdict, keep the verdict and add one sentence that says why.
End with "This week for Harlan": at most three bullets naming the labels, heads, or sites he must check.
Use plain words and short sentences. Do not use em dashes.
Never write journal, lease, fence, mutation, publication, revision, or snapshot.`

export const trialReport: RoutineDefinition = {
  ...candidateRoutine,
  // The evidence covers every mapped repository, so only the kit may publish it.
  prepare: target => target === repository
    ? ok({ _tag: 'Run', feedback: [] })
    : err(`The trial report Routine only runs in ${repository}.`),
  scanPrompt: input => `Run the ${input.name} routine against ${input.repository}.\n\n${TRIAL_REPORT_TURN}`,
  parseResponse: (input) => {
    const parsed = candidateRoutine.parseResponse(input)
    if (parsed._tag === 'Err')
      return parsed
    if (parsed.value.report === '' || parsed.value.report.length > MAXIMUM_REPORT_DETAIL_LENGTH)
      return err('The trial report Routine needs a report within 20,000 characters.')
    return parsed
  },
  // A report Routine files nothing, whatever the Agent returns.
  selectCandidates: () => [],
  issueWork: {
    prompt: () => 'Return blocked: the trial report Routine files no issues.',
    verifyChanges: () => err('The trial report Routine files no issues.'),
  },
}
