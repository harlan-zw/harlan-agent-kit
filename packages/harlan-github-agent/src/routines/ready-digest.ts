import type { RoutineDefinition } from './contract.ts'
import { err, ok } from '../result.ts'
import { candidateRoutine } from './candidates.ts'

const repository = 'harlan-zw/harlan-agent-kit'

/**
 * Lists pull requests that wait only for Harlan, every Monday.
 *
 * The controller writes the list from its own Review records and posts it to
 * the run log, so this Routine never starts an Agent turn.
 */
export const readyDigest: RoutineDefinition = {
  ...candidateRoutine,
  // The list covers every mapped repository, so only the kit may publish it.
  prepare: target => target === repository
    ? ok({ _tag: 'Run', feedback: [] })
    : err(`The ready-digest Routine only runs in ${repository}.`),
  scanPrompt: () => 'Return blocked: the controller writes the ready-digest list itself.',
  parseResponse: () => err('The ready-digest Routine runs no Agent turn.'),
  selectCandidates: () => [],
  issueWork: {
    prompt: () => 'Return blocked: the ready-digest Routine files no issues.',
    verifyChanges: () => err('The ready-digest Routine files no issues.'),
  },
}
